// Shipwright's own identity: its key, and the replaceable events that say who
// it is. All of it is (re)asserted on every boot, so changing the profile is
// editing this file and restarting.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { generateSecretKey, nip19 } from "nostr-tools";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { Signer, blossomUpload, latest, publish } from "./nostr.ts";

/** Upload assets/avatar.png once per change of the file; remember where it went. */
export async function ensureAvatar(signer: Signer): Promise<string | undefined> {
  const file = new URL("../assets/avatar.png", import.meta.url).pathname;
  const cache = `${config.stateDir}/avatar.json`;
  const sha = createHash("sha256").update(await readFile(file)).digest("hex");
  try {
    const known = JSON.parse(await readFile(cache, "utf8"));
    if (known.sha256 === sha) return known.url;
  } catch {}
  try {
    const blob = await blossomUpload(signer, file, config.blossomServers);
    await writeFile(cache, JSON.stringify(blob));
    return blob.url;
  } catch (err) {
    log.warn(`avatar upload failed: ${(err as Error).message}`);
    return undefined;
  }
}

export async function loadOrCreateKey(path = config.keyFile): Promise<Signer> {
  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const nsec = nip19.nsecEncode(generateSecretKey());
    await writeFile(path, `${nsec}\n`, { mode: 0o600, flag: "wx" });
    log.info(`generated a new identity at ${path}`);
  }
  const raw = (await readFile(path, "utf8")).trim();
  const sk = raw.startsWith("nsec1") ? (nip19.decode(raw).data as Uint8Array) : Uint8Array.from(Buffer.from(raw, "hex"));
  return new Signer(sk);
}

export function profileContent(avatar?: string): Record<string, unknown> {
  return {
    name: "Shipwright",
    display_name: "Shipwright",
    about: [
      "I build and repair Armada. Report a bug or ask for a feature in the community (mention me, reply to me, or post in a bug/feature channel) and I'll implement it, then come back with a preview link, screenshots, and a pull request on ngit for the maintainers to review.",
      "",
      "An AI agent (Claude), run by Soapbox.",
    ].join("\n"),
    picture: avatar,
    bot: true,
    website: config.repoWeb,
  };
}

/** Bot commands Armada offers in the composer (kind 10304). */
export const COMMANDS = [
  { name: "bug", description: "Report a bug for Shipwright to fix", args: [{ name: "description", type: "string", description: "What's broken, and how to make it happen", required: true }] },
  { name: "feature", description: "Ask Shipwright to build something", args: [{ name: "description", type: "string", description: "What you'd like Armada to do", required: true }] },
  { name: "tasks", description: "What Shipwright is working on", args: [] },
];

/** Publish an event only if what's there differs, so boots don't churn relays. */
async function assert(signer: Signer, relays: string[], kind: number, content: string, tags: string[][]): Promise<void> {
  const current = await latest(relays, kind, signer.pubkey).catch(() => undefined);
  if (current && current.content === content && JSON.stringify(current.tags) === JSON.stringify(tags)) return;
  await publish(signer.sign({ kind, content, tags }), relays);
  log.info(`published kind ${kind}`);
}

export async function assertIdentity(signer: Signer, communityRelays: string[], avatar?: string): Promise<void> {
  const everywhere = [...new Set([...config.appRelays, ...communityRelays])];
  // Kind 0 with stable key order, so the comparison above is meaningful.
  await assert(signer, everywhere, 0, JSON.stringify(profileContent(avatar)), []);
  // Our outbox/inbox (NIP-65), our media servers (BUD-03), our commands.
  await assert(signer, everywhere, 10002, "", config.appRelays.map((r) => ["r", r]));
  // Gateways resolve preview blobs through this list, so the servers that
  // send uncompressed bytes go first (see nsiteBlossom in config.ts).
  const servers = [...new Set([...config.nsiteBlossom, ...config.blossomServers])];
  await assert(signer, everywhere, 10063, "", servers.map((s) => ["server", s]));
  await assert(signer, everywhere, 10304, JSON.stringify({ v: 1, commands: COMMANDS }), []);
}
