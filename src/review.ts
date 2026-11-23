// Code review on ngit: what the repository's maintainers say on Shipwright's
// pull requests. Only maintainers are heard; everyone else's comments are
// never read. Like chat, it works quietly: a comment that asks for a change
// or a question goes to the task's agent with no acknowledgement, and the one
// reply on the PR comes when the work (or the answer) is done.
import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { nip19, type Event } from "nostr-tools";
import { queryProfile } from "nostr-tools/nip05";
import type { SubCloser } from "nostr-tools/abstract-pool";
import { config } from "./config.ts";
import type { Coordinator } from "./coordinator.ts";
import { log } from "./log.ts";
import { type Signer, pool, publish } from "./nostr.ts";
import type { Task, TaskStore } from "./tasks.ts";

const KIND_COMMENT = 1111;
const KIND_PR = 1618;
const KIND_REPO = 30617;
/** NIP-34 statuses: open, merged/applied, closed, draft. */
const STATUS_KINDS = [1630, 1631, 1632, 1633];
const STATUS_NAME: Record<number, string> = { 1630: "open", 1631: "merged", 1632: "closed", 1633: "draft" };
/** Reviewers leave several comments in a row; read them as one review. */
const QUIET_MS = 90_000;
const MAX_WAIT_MS = 10 * 60_000;
const CATCH_UP_MS = 7 * 24 * 3600_000;
/** PRs older than this are no longer watched. */
const WATCH_DAYS = 60;

export interface PrComment {
  id: string;
  pubkey: string;
  content: string;
  createdAt: number;
  /** The comment this one answers, if it isn't on the PR itself. */
  parent?: string;
}

/** nostr://<owner>/<relay>…/<identifier>, the owner an npub or a NIP-05 name. */
function parseRepo(url: string): { owner: string; relays: string[]; d: string } {
  const parts = url.replace(/^nostr:\/\//, "").split("/").filter(Boolean);
  const d = parts.at(-1) ?? "";
  return { owner: parts[0] ?? "", relays: parts.slice(1, -1).map((r) => `wss://${decodeURIComponent(r)}`), d };
}

const repo = parseRepo(config.repo);
export const reviewRelays = [...new Set([...repo.relays, ...config.gitRelays])];

async function ownerPubkey(): Promise<string | undefined> {
  if (config.repoOwner) return config.repoOwner;
  if (repo.owner.startsWith("npub1")) return nip19.decode(repo.owner as `npub1${string}`).data as string;
  const name = repo.owner.includes("@") ? repo.owner : `_@${repo.owner}`;
  return (await queryProfile(name))?.pubkey;
}

/**
 * Post a comment on a pull request (NIP-22, as gitworkshop does): rooted on
 * the PR, in reply to the comment that asked.
 */
export async function replyOnPr(signer: Signer, task: Task, parent: { id: string; pubkey: string }, text: string): Promise<string> {
  const root = task.prEventId;
  if (!root) throw new Error(`#${task.id} has no pull request`);
  const relay = reviewRelays[0] ?? "";
  const event = signer.sign({
    kind: KIND_COMMENT,
    content: text,
    tags: [
      ["E", root, relay, signer.pubkey],
      ["K", String(KIND_PR)],
      ["P", signer.pubkey, relay],
      ["e", parent.id, relay, parent.pubkey],
      ["k", String(parent.id === root ? KIND_PR : KIND_COMMENT)],
      ["p", parent.pubkey, relay],
    ],
  });
  await publish(event, reviewRelays);
  return event.id;
}

interface Persisted {
  handled: string[];
  lastSeen: number;
}

export class ReviewWatcher {
  tasks: TaskStore;
  coordinator: Coordinator;
  self: string;
  maintainers = new Set<string>();
  #handled = new Set<string>();
  #lastSeen = 0;
  #file = `${config.stateDir}/review.json`;
  #sub?: SubCloser;
  #watching = "";
  #pending = new Map<string, { comments: PrComment[]; firstAt: number; timer?: NodeJS.Timeout }>();
  #busy = new Map<string, Promise<void>>();
  #writing: Promise<void> = Promise.resolve();

  constructor(deps: { tasks: TaskStore; coordinator: Coordinator; self: string }) {
    this.tasks = deps.tasks;
    this.coordinator = deps.coordinator;
    this.self = deps.self;
    if (existsSync(this.#file)) {
      try {
        const p = JSON.parse(readFileSync(this.#file, "utf8")) as Persisted;
        this.#handled = new Set(p.handled);
        this.#lastSeen = p.lastSeen;
      } catch (err) {
        log.warn(`review state unreadable (${(err as Error).message}); starting without it`);
      }
    }
  }

  async start(): Promise<void> {
    await this.#loadMaintainers();
    this.#resubscribe();
    // New PRs join the subscription; the maintainer list follows the repo.
    setInterval(() => this.#resubscribe(), 60_000);
    setInterval(() => void this.#loadMaintainers(), 3600_000);
  }

  /**
   * The owner, the maintainers its announcement lists, and the ones theirs
   * list (ngit's rule: a maintainer's own announcement can add more).
   */
  async #loadMaintainers(): Promise<void> {
    try {
      const owner = await ownerPubkey();
      if (!owner) throw new Error(`can't resolve the owner of ${config.repo}`);
      const found = new Set([owner]);
      let frontier = [owner];
      for (let depth = 0; depth < 2 && frontier.length; depth++) {
        const events = await pool.querySync(reviewRelays, { kinds: [KIND_REPO], authors: frontier, "#d": [repo.d] }, { maxWait: 6000 });
        frontier = [];
        for (const e of events) {
          for (const t of e.tags) {
            if (t[0] !== "maintainers") continue;
            for (const pk of t.slice(1)) {
              if (/^[0-9a-f]{64}$/.test(pk) && !found.has(pk)) {
                found.add(pk);
                frontier.push(pk);
              }
            }
          }
        }
      }
      found.delete(this.self);
      if (found.size) this.maintainers = found;
      log.info(`review: ${this.maintainers.size} maintainers of ${repo.d}`);
    } catch (err) {
      // Keep the last list: an empty one would silence every reviewer.
      log.warn(`review: loading maintainers failed: ${(err as Error).message}`);
    }
  }

  #watched(): Task[] {
    const since = Date.now() - WATCH_DAYS * 24 * 3600_000;
    return this.tasks.tasks.filter((t) => t.prEventId && t.updatedAt > since);
  }

  #resubscribe(): void {
    const ids = this.#watched().map((t) => t.prEventId as string).sort();
    const key = ids.join(",");
    if (key === this.#watching) return;
    this.#watching = key;
    this.#sub?.close();
    if (!ids.length) return;
    const since = Math.floor((this.#lastSeen ? this.#lastSeen : Date.now() - CATCH_UP_MS) / 1000) - 600;
    this.#sub = pool.subscribeMany(reviewRelays, { kinds: [KIND_COMMENT], "#E": ids, since }, { onevent: (e) => this.#onEvent(e) });
    log.info(`review: watching ${ids.length} pull requests`);
  }

  #onEvent(e: Event): void {
    if (this.#handled.has(e.id) || e.pubkey === this.self) return;
    // Only maintainers are heard. Others aren't marked handled, so a
    // maintainer added later doesn't lose what they said meanwhile.
    if (!this.maintainers.has(e.pubkey)) return;
    const root = e.tags.find((t) => t[0] === "E")?.[1];
    const task = this.tasks.tasks.find((t) => t.prEventId && t.prEventId === root);
    if (!task) return;
    this.#handled.add(e.id);
    this.#lastSeen = Math.max(this.#lastSeen, Math.min(e.created_at * 1000, Date.now()));
    void this.#save();
    const parent = e.tags.find((t) => t[0] === "e")?.[1];
    const comment: PrComment = { id: e.id, pubkey: e.pubkey, content: e.content, createdAt: e.created_at, parent: parent === root ? undefined : parent };
    log.info(`[${task.id}] review comment from ${e.pubkey.slice(0, 8)}`);
    const entry = this.#pending.get(task.id) ?? { comments: [], firstAt: Date.now() };
    entry.comments.push(comment);
    clearTimeout(entry.timer);
    const delay = Math.max(0, Math.min(QUIET_MS, entry.firstAt + MAX_WAIT_MS - Date.now()));
    entry.timer = setTimeout(() => this.#flush(task), delay);
    this.#pending.set(task.id, entry);
  }

  #flush(task: Task): void {
    const entry = this.#pending.get(task.id);
    if (!entry) return;
    this.#pending.delete(task.id);
    const prev = this.#busy.get(task.id) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const status = await this.#status(task);
        if (status === "merged" || status === "closed") {
          log.info(`[${task.id}] review comment on a ${status} pull request; leaving it`);
          return;
        }
        const thread = await this.#thread(task);
        const fresh = entry.comments.sort((a, b) => a.createdAt - b.createdAt);
        await this.coordinator.review(task, thread, fresh);
      })
      .catch((err) => log.error(`[${task.id}] review turn: ${(err as Error).message}`));
    this.#busy.set(task.id, next);
  }

  /** The PR's latest status from a maintainer (or us); open if none. */
  async #status(task: Task): Promise<string> {
    try {
      const events = await pool.querySync(reviewRelays, { kinds: STATUS_KINDS, "#e": [task.prEventId as string] }, { maxWait: 5000 });
      const trusted = events.filter((e) => this.maintainers.has(e.pubkey) || e.pubkey === this.self).sort((a, b) => b.created_at - a.created_at);
      return STATUS_NAME[trusted[0]?.kind ?? 1630] ?? "open";
    } catch {
      return "open";
    }
  }

  /** The PR's review so far: maintainers' comments and ours, oldest first. */
  async #thread(task: Task): Promise<PrComment[]> {
    try {
      const events = await pool.querySync(reviewRelays, { kinds: [KIND_COMMENT], "#E": [task.prEventId as string] }, { maxWait: 5000 });
      const seen = new Set<string>();
      return events
        .filter((e) => (this.maintainers.has(e.pubkey) || e.pubkey === this.self) && !seen.has(e.id) && seen.add(e.id))
        .sort((a, b) => a.created_at - b.created_at)
        .slice(-30)
        .map((e) => ({ id: e.id, pubkey: e.pubkey, content: e.content, createdAt: e.created_at, parent: e.tags.find((t) => t[0] === "e")?.[1] }));
    } catch {
      return [];
    }
  }

  /** Serialized, write-then-rename (see Chat.save). */
  #save(): Promise<void> {
    this.#writing = this.#writing.then(async () => {
      const p: Persisted = { handled: [...this.#handled].slice(-2000), lastSeen: this.#lastSeen };
      try {
        await writeFile(`${this.#file}.tmp`, JSON.stringify(p));
        await rename(`${this.#file}.tmp`, this.#file);
      } catch (err) {
        log.warn(`saving review state: ${(err as Error).message}`);
      }
    });
    return this.#writing;
  }
}
