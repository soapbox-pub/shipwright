// Plain (non-Concord) Nostr: our own replaceable events, profile lookups,
// Blossom uploads. Community traffic never comes through here.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { finalizeEvent, getPublicKey, nip19, type Event, type EventTemplate } from "nostr-tools";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket from "ws";
import { log } from "./log.ts";

// Not Node's built-in WebSocket: when a relay fails to connect, nostr-tools'
// onerror calls close(), which on undici's WebSocket fires onerror again,
// synchronously, until the stack overflows and the process dies (seen with
// relay.dreamith.to answering 502: 500 restarts in three hours).
//
// SimplePool MUST come from "nostr-tools/pool", the same bundle as
// useWebSocketImplementation: the package's main entry is a separate bundle
// with its own copy of the setting, and importing the pool from there quietly
// keeps the built-in WebSocket.
//
// And ws itself emits 'error' when a socket is closed before it connects,
// which nostr-tools does on a connection timeout; with no listener attached
// at that moment, Node throws it and the service dies. Every socket gets a
// listener from birth. nostr-tools' own onerror still sees the error.
class QuietWebSocket extends WebSocket {
  constructor(...args: ConstructorParameters<typeof WebSocket>) {
    super(...args);
    this.on("error", () => {});
  }
}
useWebSocketImplementation(QuietWebSocket);

export const pool = new SimplePool({ enablePing: true, enableReconnect: true });

export class Signer {
  readonly sk: Uint8Array;
  readonly pubkey: string;
  constructor(sk: Uint8Array) {
    this.sk = sk;
    this.pubkey = getPublicKey(sk);
  }
  get npub(): string {
    return nip19.npubEncode(this.pubkey);
  }
  sign(t: Omit<EventTemplate, "created_at"> & { created_at?: number }): Event {
    return finalizeEvent({ created_at: Math.floor(Date.now() / 1000), ...t }, this.sk);
  }
}

/** Publish to every relay; succeed if any accepts. */
export async function publish(event: Event, relays: string[]): Promise<number> {
  const results = await Promise.allSettled(pool.publish(relays, event));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  if (ok === 0) {
    const why = results.map((r) => (r.status === "rejected" ? String(r.reason) : "")).filter(Boolean).join("; ");
    throw new Error(`no relay accepted kind ${event.kind}: ${why}`);
  }
  log.debug(`published kind ${event.kind} to ${ok}/${relays.length} relays`);
  return ok;
}

/** querySync can wait forever on a relay that never sends EOSE. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("relay query timed out")), ms))]);
}

export async function latest(relays: string[], kind: number, author: string): Promise<Event | undefined> {
  const events = await withTimeout(pool.querySync(relays, { kinds: [kind], authors: [author], limit: 4 }, { maxWait: 6000 }), 10_000);
  return events.sort((a, b) => b.created_at - a.created_at)[0];
}

// ── Profiles ────────────────────────────────────────────────────────────────

export interface Profile {
  name?: string;
  display_name?: string;
  nip05?: string;
}

const profiles = new Map<string, { at: number; profile: Profile }>();
const PROFILE_TTL = 6 * 3600_000;

export async function profileNames(pubkeys: string[], relays: string[]): Promise<Map<string, string>> {
  const now = Date.now();
  const missing = [...new Set(pubkeys)].filter((pk) => (profiles.get(pk)?.at ?? 0) < now - PROFILE_TTL);
  if (missing.length > 0 && relays.length > 0) {
    try {
      const events = await withTimeout(pool.querySync(relays, { kinds: [0], authors: missing }, { maxWait: 4000 }), 8000);
      const newest = new Map<string, Event>();
      for (const e of events) if ((newest.get(e.pubkey)?.created_at ?? 0) < e.created_at) newest.set(e.pubkey, e);
      for (const pk of missing) {
        let profile: Profile = {};
        try {
          profile = JSON.parse(newest.get(pk)?.content ?? "{}");
        } catch {}
        profiles.set(pk, { at: now, profile });
      }
    } catch (err) {
      log.warn(`profile lookup failed: ${(err as Error).message}`);
    }
  }
  const out = new Map<string, string>();
  for (const pk of pubkeys) {
    const p = profiles.get(pk)?.profile ?? {};
    const name = (p.display_name || p.name || "").replace(/\s+/g, " ").trim().slice(0, 40);
    out.set(pk, name || `${nip19.npubEncode(pk).slice(0, 12)}…`);
  }
  return out;
}

// ── Blossom (BUD-01/02) ─────────────────────────────────────────────────────

export interface Blob {
  url: string;
  sha256: string;
  size: number;
  type: string;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
};

export function mimeOf(path: string): string {
  return MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

/** Upload to every server; return the first copy that verifies. */
export async function blossomUpload(signer: Signer, path: string, servers: string[]): Promise<Blob> {
  const body = await readFile(path);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const type = mimeOf(path);
  const auth = signer.sign({
    kind: 24242,
    content: "Upload blob",
    tags: [
      ["t", "upload"],
      ["x", sha256],
      ["expiration", String(Math.floor(Date.now() / 1000) + 600)],
    ],
  });
  const header = `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`;
  const attempts = await Promise.allSettled(
    servers.map(async (server) => {
      const base = server.replace(/\/$/, "");
      const res = await fetch(`${base}/upload`, {
        method: "PUT",
        headers: { authorization: header, "content-type": type, "x-sha-256": sha256 },
        body,
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`${base}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const desc = (await res.json()) as { url?: string; sha256?: string };
      if (desc.sha256 && desc.sha256 !== sha256) throw new Error(`${base}: stored a different hash`);
      const ext = path.split(".").pop();
      return desc.url ?? `${base}/${sha256}.${ext}`;
    }),
  );
  const urls = attempts.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
  if (urls.length === 0) {
    throw new Error(`blossom upload failed everywhere: ${attempts.map((a) => (a as PromiseRejectedResult).reason?.message).join("; ")}`);
  }
  return { url: urls[0], sha256, size: body.length, type };
}

// ── nsite gateway URLs ──────────────────────────────────────────────────────

/** A named site's gateway label: base36 pubkey (50 chars) then the d tag. */
export function nsiteUrl(pubkeyHex: string, d: string, gateway: string): string {
  const b36 = BigInt(`0x${pubkeyHex}`).toString(36).padStart(50, "0");
  return `https://${b36}${d}.${gateway}/`;
}
