// Shipwright: boot, wiring, and deciding which messages deserve a look.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AuthProxy } from "./authproxy.ts";
import { Chat, type Msg } from "./chat.ts";
import type { ChatMessage, Ready } from "./concord.ts";
import { ConcordIO } from "./concord.ts";
import { config } from "./config.ts";
import { Coordinator, type Mode } from "./coordinator.ts";
import { assertIdentity, ensureAvatar, loadOrCreateKey } from "./identity.ts";
import { log } from "./log.ts";
import { ReviewWatcher } from "./review.ts";
import { Runner } from "./runner.ts";
import { TaskStore } from "./tasks.ts";

/** Batching: a quick turn when addressed, a lull (with a cap) when overheard. */
const DEBOUNCE_MS = 3_500;
const AMBIENT_QUIET_MS = 30_000;
const AMBIENT_MAX_WAIT_MS = 120_000;
/** The live subscription replays the last minute on every (re)subscribe. */
const REPLAY_GRACE_MS = 2 * 60_000;
const PER_USER_TURNS_PER_HOUR = 30;
const SLASH = /^\/(bug|feature|tasks|shipwright)\b/i;
/** How far back a restart looks for messages it missed. */
const CATCH_UP_MS = 6 * 3600_000;

mkdirSync(config.stateDir, { recursive: true });
// The CLI refuses to edit tasks while this runs: the service holds them in
// memory and would write its copy over the CLI's.
writeFileSync(`${config.stateDir}/service.pid`, String(process.pid));
const signer = await loadOrCreateKey();
log.info(`I am ${signer.npub}`);

// Read on every request, so the token can be rotated without a restart.
const proxy = new AuthProxy(() => readFileSync(config.claudeTokenFile, "utf8").trim());
await proxy.listen();

const tasks = new TaskStore();
tasks.load();
const io = new ConcordIO();
const chat = new Chat(io);
chat.self = signer.pubkey;
chat.relays = config.appRelays;
const runner = new Runner({ tasks, chat, proxy, signer });
const coordinator = new Coordinator({ chat, tasks, runner, proxy });
// Maintainers' comments on our pull requests, over plain Nostr, independent of the community.
const review = new ReviewWatcher({ tasks, coordinator, self: signer.pubkey });
void review.start().catch((err) => log.warn(`review: ${err.message}`));

// Say who we are before the community first sees us join.
const avatar = await ensureAvatar(signer);
await assertIdentity(signer, [], avatar).catch((err) => log.warn(`identity: ${err.message}`));

const bootAt = Date.now();
let readyOnce = false;

io.on("ready", async (ready: Ready) => {
  chat.setChannels(ready.channels);
  chat.relays = [...new Set([...config.appRelays, ...ready.community.relays])];
  coordinator.community = ready.community.name;
  log.info(`member of "${ready.community.name}" with ${ready.channels.length} channels: ${ready.channels.map((c) => `#${c.name}`).join(" ")}`);
  if (readyOnce) return;
  readyOnce = true;
  await assertIdentity(signer, ready.community.relays, avatar).catch((err) => log.warn(`identity: ${err.message}`));
  // Prime the buffers so the coordinator has context from the first message,
  // and catch up on whatever addressed us while we were down.
  const since = Math.max(chat.lastSeenMs, Date.now() - CATCH_UP_MS);
  const missed: Msg[] = [];
  for (const c of ready.channels) {
    try {
      for (const h of await io.history(c.id, 100)) {
        const m: Msg = { ...h, channel: c.id, channel_name: c.name };
        chat.ingest(m);
        if (m.ms > since && m.ms < bootAt - REPLAY_GRACE_MS && !chat.handled.has(m.id)) missed.push(m);
      }
    } catch (err) {
      log.warn(`history for #${c.name}: ${(err as Error).message}`);
    }
  }
  await introduce(ready).catch((err) => log.warn(`introduction: ${err.message}`));
  catchUp(missed);
  runner.kick();
});

/**
 * Messages that arrived while we were down. Only the ones addressed to us:
 * a request or a reply deserves an answer, however late, but starting work
 * from hours-old ambient chatter would revive conversations that moved on.
 */
function catchUp(missed: Msg[]): void {
  missed.sort((a, b) => a.ms - b.ms);
  let n = 0;
  for (const m of missed) {
    chat.handled.add(m.id);
    if (classify(m) !== "direct") continue;
    enqueue(m, "direct");
    n++;
  }
  if (missed.length) {
    chat.lastSeenMs = Math.max(chat.lastSeenMs, ...missed.map((m) => m.ms));
    chat.save();
  }
  log.info(`caught up on ${missed.length} missed messages; ${n} addressed to me`);
}
io.on("channels", (channels) => chat.setChannels(channels));
io.on("message", (m: ChatMessage) => onMessage(m));
io.start();

/** Once per community: say hello where bugs and ideas are discussed. */
async function introduce(ready: Ready): Promise<void> {
  if (chat.introduced === ready.community.id) return;
  const text = ready.channels.filter((c) => !c.private && c.view !== "voice");
  const home = text.find((c) => config.watchChannels.test(c.name)) ?? text.find((c) => /general|chat|lobby/i.test(c.name)) ?? text[0];
  if (!home) return;
  await chat.post(
    home.id,
    [
      "👋 Hi, I'm Shipwright, an AI agent that works on Armada.",
      `Mention me or reply to me with a bug or a feature idea${config.watchChannels.test(home.name) ? ", or just post it here," : ""} and I'll build it: you'll get a preview link to try, screenshots, and a pull request for the maintainers to review.`,
    ].join(" "),
  );
  chat.markIntroduced(ready.community.id);
  log.info(`introduced myself in #${home.name}`);
}

// ── Deciding what deserves the coordinator's attention ─────────────────────

const pending = new Map<string, { msgs: Msg[]; mode: Mode; firstAt: number; timer?: NodeJS.Timeout }>();
const busy = new Map<string, Promise<void>>();
const turns = new Map<string, number[]>();

function classify(m: Msg): Mode | undefined {
  if (m.pubkey === chat.self || (m.kind !== 9 && m.kind !== 1111)) return undefined;
  const parent = chat.parentOf(m);
  const root = chat.threadRootOf(m);
  if (chat.mentionsUs(m)) return "direct";
  if (SLASH.test(m.content.trim())) return "direct";
  if (parent && (chat.ours.has(parent) || tasks.byMessage(parent))) return "direct";
  if (root && (chat.ours.has(root) || tasks.byMessage(root))) return "direct";
  if (config.watchChannels.test(chat.name(m.channel))) return "ambient";
  return undefined;
}

function rateLimited(pubkey: string): boolean {
  const now = Date.now();
  const recent = (turns.get(pubkey) ?? []).filter((t) => t > now - 3600_000);
  turns.set(pubkey, recent);
  if (recent.length >= PER_USER_TURNS_PER_HOUR) return true;
  recent.push(now);
  return false;
}

function onMessage(m: ChatMessage): void {
  chat.ingest(m);
  if (chat.handled.has(m.id)) return;
  chat.handled.add(m.id);
  chat.lastSeenMs = Math.max(chat.lastSeenMs, Math.min(m.ms, Date.now()));
  chat.save();
  if (m.ms < bootAt - REPLAY_GRACE_MS) return; // history, not news (catchUp handles what we missed)
  const mode = classify(m);
  if (mode) enqueue(m, mode);
}

function enqueue(m: Msg, mode: Mode): void {
  if (rateLimited(m.pubkey)) {
    log.warn(`rate limiting ${m.pubkey.slice(0, 8)}`);
    return;
  }
  // Batch a burst into one turn per channel. People type a thought as several
  // messages seconds apart; a 3.5 s window cut one person's eight messages
  // into separate turns that each saw half an idea, and with silent starts
  // that means a task begun on the first half. So in watched channels wait
  // for a lull, capped so a busy channel can't hold a batch forever; when
  // someone addresses Shipwright, answer fast.
  const entry = pending.get(m.channel) ?? { msgs: [], mode, firstAt: Date.now() };
  entry.msgs.push(m);
  if (mode === "direct") entry.mode = "direct";
  clearTimeout(entry.timer);
  const quiet = entry.mode === "direct" ? DEBOUNCE_MS : AMBIENT_QUIET_MS;
  const delay = Math.max(0, Math.min(quiet, entry.firstAt + AMBIENT_MAX_WAIT_MS - Date.now()));
  entry.timer = setTimeout(() => flush(m.channel), delay);
  pending.set(m.channel, entry);
}

function flush(channel: string): void {
  const entry = pending.get(channel);
  if (!entry) return;
  pending.delete(channel);
  // One turn at a time per channel, in order.
  const prev = busy.get(channel) ?? Promise.resolve();
  const next = prev.then(() => coordinator.handle(channel, entry.msgs, entry.mode)).catch((err) => log.error(`turn: ${err.message}`));
  busy.set(channel, next);
}

setInterval(() => void runner.sweep().catch((err) => log.warn(`sweep: ${err.message}`)), 6 * 3600_000);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log.info("stopping");
    io.stop();
    void Promise.all([tasks.save(), chat.flush()]).finally(() => process.exit(0));
  });
}
