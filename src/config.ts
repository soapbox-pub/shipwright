// Every knob in one place. Production values are the defaults; /etc/shipwright/env
// overrides any of them (and must supply SHIPWRIGHT_INVITE until the first join).
const env = (k: string, d: string): string => process.env[k]?.trim() || d;
const list = (k: string, d: string[]): string[] =>
  process.env[k]?.split(",").map((s) => s.trim()).filter(Boolean) ?? d;
const int = (k: string, d: number): number => Number.parseInt(process.env[k] ?? "", 10) || d;

export const config = {
  stateDir: env("SHIPWRIGHT_STATE_DIR", "/var/lib/shipwright/state"),
  keyFile: env("SHIPWRIGHT_KEY_FILE", "/var/lib/shipwright/secrets/nsec"),
  claudeTokenFile: env("SHIPWRIGHT_CLAUDE_TOKEN_FILE", "/var/lib/shipwright/secrets/claude-token"),
  invite: process.env.SHIPWRIGHT_INVITE?.trim(),
  concordIo: env("SHIPWRIGHT_CONCORD_IO", "/opt/shipwright/bin/concord-io"),
  /** Home for the coordinator's Claude Code sessions (no secrets in it). */
  coordinatorHome: env("SHIPWRIGHT_COORDINATOR_HOME", "/var/lib/shipwright/coordinator"),

  // ── The repository Shipwright works on ──
  repo: env("SHIPWRIGHT_REPO", "nostr://soapbox.pub/relay.ngit.dev/armada"),
  repoWeb: env("SHIPWRIGHT_REPO_WEB", "https://gitworkshop.dev/soapbox.pub/relay.ngit.dev/armada"),
  defaultBranch: env("SHIPWRIGHT_DEFAULT_BRANCH", "main"),
  mirrorDir: env("SHIPWRIGHT_MIRROR_DIR", "/var/lib/shipwright/repos/armada"),
  publishDir: env("SHIPWRIGHT_PUBLISH_DIR", "/var/lib/shipwright/repos/publish"),
  workDir: env("SHIPWRIGHT_WORK_DIR", "/srv/shipwright/work"),
  /** How the worker's commands are run. Empty means "as ourselves" (local dev only). */
  asWorker: list("SHIPWRIGHT_AS_WORKER", ["sudo", "-n", "-u", "shipwright-worker", "/opt/shipwright/libexec/as-worker"]),
  workerHome: env("SHIPWRIGHT_WORKER_HOME", "/var/lib/shipwright-worker"),
  /** Open PRs for real. Off means: do everything else and log the PR it would have sent. */
  openPrs: env("SHIPWRIGHT_OPEN_PRS", "1") === "1",

  // ── Models ──
  coordinatorModel: env("SHIPWRIGHT_COORDINATOR_MODEL", "claude-haiku-5-5"),
  workerModel: env("SHIPWRIGHT_WORKER_MODEL", "claude-opus-5-5"),
  /** How the worker model is named to people, in PRs. */
  workerModelName: env("SHIPWRIGHT_WORKER_MODEL_NAME", "Claude Opus 5.5"),

  // ── Limits (anyone in the community can start work, so these are the brakes) ──
  maxParallel: int("SHIPWRIGHT_MAX_PARALLEL", 3),
  dailyTaskCap: int("SHIPWRIGHT_DAILY_TASK_CAP", 20),
  perUserDailyCap: int("SHIPWRIGHT_PER_USER_DAILY_CAP", 5),
  workerTimeoutMin: int("SHIPWRIGHT_WORKER_TIMEOUT_MIN", 120),
  workerMaxTurns: int("SHIPWRIGHT_WORKER_MAX_TURNS", 600),
  /** CPU per worker's test runs; three workers share 16 cores. */
  testWorkers: int("SHIPWRIGHT_TEST_WORKERS", 4),
  devPortBase: int("SHIPWRIGHT_DEV_PORT_BASE", 9100),

  // ── Where Shipwright listens without being addressed ──
  watchChannels: new RegExp(env("SHIPWRIGHT_WATCH_CHANNELS", "bug|feature|request|feedback|issue|support|suggest|idea"), "i"),

  // ── Nostr ──
  appRelays: list("SHIPWRIGHT_APP_RELAYS", ["wss://relay.ditto.pub", "wss://relay.dreamith.to", "wss://relay.primal.net"]),
  /** Where the PR events go besides the repo's own relays. */
  gitRelays: list("SHIPWRIGHT_GIT_RELAYS", ["wss://relay.ngit.dev", "wss://git.shakespeare.diy"]),
  /** Screenshots and video: browsers fetch these directly. */
  blossomServers: list("SHIPWRIGHT_BLOSSOM", ["https://blossom.ditto.pub", "https://blossom.primal.net", "https://nostr.download"]),
  /**
   * Preview sites. Only servers that send blobs uncompressed: nsite.lol keeps
   * an upstream's compressed Content-Length while serving the decompressed
   * body, so through blossom.ditto.pub (brotli) every file arrives cut to a
   * quarter of its size and the preview is a blank page (seen 2026-11-20).
   */
  nsiteBlossom: list("SHIPWRIGHT_NSITE_BLOSSOM", ["https://nostr.download", "https://blossom.primal.net"]),
  nsiteRelays: list("SHIPWRIGHT_NSITE_RELAYS", ["wss://relay.ditto.pub", "wss://relay.dreamith.to", "wss://relay.primal.net"]),
  /**
   * nsite.run serves Armada builds intact. nsite.lol does not: it truncated
   * every file to its brotli size and cached that by hash (2026-11-20), which
   * poisons the chunks every Armada build shares.
   */
  nsiteGateway: env("SHIPWRIGHT_NSITE_GATEWAY", "nsite.run"),
};
