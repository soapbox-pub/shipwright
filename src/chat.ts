// What Shipwright remembers of the conversation, and how it speaks in it.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { nip19 } from "nostr-tools";
import type { Channel, ChatMessage, ConcordIO } from "./concord.ts";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { profileNames } from "./nostr.ts";
import type { Media, SourceRef } from "./tasks.ts";

const KIND_MESSAGE = 9;
const KIND_COMMENT = 1111;
const KIND_REACTION = 7;
const KIND_EDIT = 3302;
const KIND_DELETE = 5;
const BUFFER = 80;

export type Msg = Omit<ChatMessage, "moderator"> & { moderator?: boolean };

interface Persisted {
  ours: string[];
  handled: string[];
  introduced?: string;
  lastSeenMs?: number;
}

export class Chat {
  io: ConcordIO;
  self = "";
  relays: string[] = [];
  channels = new Map<string, Channel>();
  buffers = new Map<string, Msg[]>();
  ours = new Set<string>();
  handled = new Set<string>();
  introduced?: string;
  /** Newest message handled, so a restart can catch up on what it missed. */
  lastSeenMs = 0;
  #file = `${config.stateDir}/chat.json`;
  #introFile = `${config.stateDir}/introduced`;
  #writing: Promise<void> = Promise.resolve();
  #dirty = false;

  constructor(io: ConcordIO) {
    this.io = io;
    if (existsSync(this.#introFile)) this.introduced = readFileSync(this.#introFile, "utf8").trim();
    if (existsSync(this.#file)) {
      try {
        const p = JSON.parse(readFileSync(this.#file, "utf8")) as Persisted;
        this.ours = new Set(p.ours);
        this.handled = new Set(p.handled);
        this.introduced ??= p.introduced;
        this.lastSeenMs = p.lastSeenMs ?? 0;
      } catch (err) {
        // Losing this costs some context, never the service: a corrupt file
        // once kept Shipwright in a restart loop for hours.
        log.error(`chat state unreadable (${(err as Error).message}); starting without it`);
        renameSync(this.#file, `${this.#file}.corrupt-${Date.now()}`);
      }
    }
  }

  /**
   * Coalesced, serialized, write-then-rename. Saves used to fire one write per
   * message, concurrently, into the same file; two of them interleaving, or a
   * restart mid-write, left it unparseable.
   */
  save(): void {
    if (this.#dirty) return;
    this.#dirty = true;
    this.#writing = this.#writing.then(async () => {
      this.#dirty = false;
      const keep = (s: Set<string>) => [...s].slice(-2000);
      const p: Persisted = { ours: keep(this.ours), handled: keep(this.handled), introduced: this.introduced, lastSeenMs: this.lastSeenMs };
      try {
        await writeFile(`${this.#file}.tmp`, JSON.stringify(p));
        await rename(`${this.#file}.tmp`, this.#file);
      } catch (err) {
        log.warn(`saving chat state: ${(err as Error).message}`);
      }
    });
  }

  flush(): Promise<void> {
    return this.#writing;
  }

  markIntroduced(communityId: string): void {
    this.introduced = communityId;
    writeFileSync(this.#introFile, communityId);
    this.save();
  }

  setChannels(list: Channel[]): void {
    this.channels = new Map(list.map((c) => [c.id, c]));
  }

  name(channel: string): string {
    return this.channels.get(channel)?.name ?? "unknown";
  }

  /** Fold one message into the channel's buffer; edits and deletes apply in place. */
  ingest(m: Msg): void {
    const buf = this.buffers.get(m.channel) ?? [];
    this.buffers.set(m.channel, buf);
    const target = m.tags.find((t) => t[0] === "e")?.[1];
    if (m.kind === KIND_EDIT && target) {
      const orig = buf.find((x) => x.id === target && x.pubkey === m.pubkey);
      if (orig) orig.content = m.content;
      return;
    }
    if (m.kind === KIND_DELETE && target) {
      const i = buf.findIndex((x) => x.id === target && x.pubkey === m.pubkey);
      if (i >= 0) buf.splice(i, 1);
      return;
    }
    if (m.kind !== KIND_MESSAGE && m.kind !== KIND_COMMENT) return;
    if (buf.some((x) => x.id === m.id)) return;
    buf.push(m);
    buf.sort((a, b) => a.ms - b.ms);
    if (buf.length > BUFFER) buf.splice(0, buf.length - BUFFER);
  }

  find(channel: string, idOrPrefix: string): Msg | undefined {
    const p = idOrPrefix.replace(/^\[|\]$/g, "").toLowerCase();
    const buf = this.buffers.get(channel) ?? [];
    return buf.find((m) => m.id === p) ?? (p.length >= 6 ? buf.find((m) => m.id.startsWith(p)) : undefined);
  }

  // ── Who is being addressed ──

  mentionsUs(m: Msg): boolean {
    if (m.tags.some((t) => t[0] === "p" && t[1] === this.self && m.kind !== KIND_COMMENT)) return true;
    if (m.tags.some((t) => t[0] === "bot" && t[1] === this.self)) return true;
    for (const match of m.content.matchAll(/nostr:(npub1[02-9ac-hj-np-z]+|nprofile1[02-9ac-hj-np-z]+)/g)) {
      try {
        const d = nip19.decode(match[1]);
        const pk = d.type === "npub" ? d.data : (d.data as { pubkey: string }).pubkey;
        if (pk === this.self) return true;
      } catch {}
    }
    return /\bshipwright\b/i.test(m.content);
  }

  /** The message this one replies to (inline `q`, or a thread's parent `e`). */
  parentOf(m: Msg): string | undefined {
    return m.tags.find((t) => t[0] === "q")?.[1] ?? (m.kind === KIND_COMMENT ? m.tags.find((t) => t[0] === "e")?.[1] : undefined);
  }

  threadRootOf(m: Msg): string | undefined {
    return m.kind === KIND_COMMENT ? m.tags.find((t) => t[0] === "E")?.[1] : undefined;
  }

  // ── Speaking ──

  /**
   * Always a thread reply (NIP-22 kind 1111, as Armada's buildConcordCommentTags):
   * on the message itself, or in the thread it's already part of. Inline
   * kind-9 quote replies put every back-and-forth in the main channel, which
   * is noise for everyone else reading it.
   */
  replyShape(parent: SourceRef | Msg): { kind: number; tags: string[][] } {
    const tags: string[][] = [];
    const root = parent.kind === KIND_COMMENT ? parent.tags.filter(([n]) => n === "K" || n === "E" || n === "P") : [];
    if (root.length) for (const t of root) tags.push([...t]);
    else tags.push(["K", String(parent.kind)], ["E", parent.id, "", parent.pubkey], ["P", parent.pubkey]);
    tags.push(["k", String(parent.kind)], ["e", parent.id, "", parent.pubkey], ["p", parent.pubkey]);
    return { kind: KIND_COMMENT, tags };
  }

  async post(channel: string, text: string, opts: { replyTo?: SourceRef | Msg; media?: Media[] } = {}): Promise<string> {
    const shape = opts.replyTo ? this.replyShape(opts.replyTo) : { kind: KIND_MESSAGE, tags: [] as string[][] };
    // NIP-92 imeta so Armada renders the media inline; each URL is in the text.
    for (const m of opts.media ?? []) {
      if (text.includes(m.url)) shape.tags.push(["imeta", `url ${m.url}`, `m ${m.type}`, `x ${m.sha256}`]);
    }
    const { rumor_id } = await this.io.send(channel, text, shape);
    this.ours.add(rumor_id);
    this.ingest({ channel, channel_name: this.name(channel), id: rumor_id, pubkey: this.self, kind: shape.kind, content: text, tags: shape.tags, ms: Date.now() });
    this.save();
    return rumor_id;
  }

  async react(target: Msg, emoji: string): Promise<void> {
    await this.io.send(target.channel, emoji, {
      kind: KIND_REACTION,
      tags: [["e", target.id, "", target.pubkey], ["p", target.pubkey], ["k", String(target.kind)]],
    });
  }

  // ── What the coordinator reads ──

  async transcript(channel: string, limit = 40): Promise<string> {
    const buf = (this.buffers.get(channel) ?? []).slice(-limit);
    const names = await profileNames(buf.map((m) => m.pubkey), this.relays);
    return buf
      .map((m) => {
        const who = m.pubkey === this.self ? "Shipwright (you)" : `${names.get(m.pubkey)}${m.moderator ? " [mod]" : ""}`;
        const parent = this.parentOf(m);
        const re = parent ? ` (replying to [${parent.slice(0, 8)}])` : "";
        const when = new Date(m.ms).toISOString().slice(5, 16).replace("T", " ");
        return `[${m.id.slice(0, 8)}] ${when} ${who}${re}: ${m.content.slice(0, 2000)}`;
      })
      .join("\n");
  }
}
