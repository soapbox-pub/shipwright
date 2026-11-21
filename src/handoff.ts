// Taking things out of a worker's checkout without trusting it.
//
// The checkout belongs to shipwright-worker, and whatever a prompt injection
// asked for may be in it: symlinks to /var/lib/shipwright/secrets, a
// .git/config whose core.fsmonitor runs a command, files that change between
// a check and a read. So the service never opens anything there itself.
// Every read happens as the worker (its own tar, cat, git), which can only
// see what the worker could already see, and the service gets a copy in a
// private directory, with nothing in it but regular files and directories.
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { tmpdir } from "node:os";
import { runAsWorker, workerCommand } from "./proc.ts";

/**
 * A path the agent named, checked lexically: relative, normalized, and
 * inside `under`. The worker does the actual resolving, as itself.
 */
export function workerPath(rel: string, under: string): string | undefined {
  if (typeof rel !== "string" || rel.includes("\0")) return undefined;
  const path = posix.normalize(rel.replace(/^\.\//, ""));
  if (posix.isAbsolute(path) || path === ".." || path.startsWith("../")) return undefined;
  return path === under || path.startsWith(`${under.replace(/\/$/, "")}/`) ? path : undefined;
}

/** A text file from the checkout, read as the worker (at most 64 KiB). */
export async function readAsWorker(path: string): Promise<string | undefined> {
  const res = await runAsWorker("cat", ["--", path], { check: false, timeoutMs: 60_000 });
  return res.code === 0 ? res.stdout : undefined;
}

/**
 * Copy `paths` (relative to `dir`) out of a worker's checkout into a new
 * private directory, and return it. The worker's tar dereferences links,
 * as the worker; ours unpacks into a directory only we can read. Anything
 * that comes out as neither a file nor a directory is deleted.
 */
export async function exportFromWorker(dir: string, paths: string[], maxBytes: number): Promise<string> {
  const dest = await mkdtemp(join(tmpdir(), "sw-handoff-"));
  try {
    await pipeTar(dir, paths, dest, maxBytes);
    await scrub(dest);
    return dest;
  } catch (err) {
    await rm(dest, { recursive: true, force: true });
    throw err;
  }
}

function pipeTar(dir: string, paths: string[], dest: string, maxBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const { command, args } = workerCommand("tar", ["-C", dir, "--dereference", "--hard-dereference", "-cf", "-", "--", ...paths], {});
    const src = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    const sink = spawn("tar", ["-C", dest, "-xf", "-", "--no-same-owner", "--no-same-permissions", "--no-overwrite-dir"], {
      stdio: ["pipe", "ignore", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    let bytes = 0;
    let failed: Error | undefined;
    let srcErr = "";
    let sinkErr = "";
    const fail = (err: Error) => {
      if (failed) return;
      failed = err;
      src.kill("SIGKILL");
      sink.kill("SIGKILL");
    };
    const timer = setTimeout(() => fail(new Error("handoff timed out")), 10 * 60_000);
    src.stderr.on("data", (d) => (srcErr = (srcErr + d).slice(-2000)));
    sink.stderr.on("data", (d) => (sinkErr = (sinkErr + d).slice(-2000)));
    src.stdout.on("data", (d: Buffer) => {
      bytes += d.length;
      if (bytes > maxBytes) fail(new Error(`handoff larger than ${Math.round(maxBytes / 1048576)} MiB`));
    });
    src.stdout.pipe(sink.stdin);
    sink.stdin.on("error", () => {}); // EPIPE when the sink is killed
    src.on("error", fail);
    sink.on("error", fail);
    let open = 2;
    const codes: Record<string, number | null> = {};
    const done = (name: string) => (code: number | null) => {
      codes[name] = code;
      if (--open > 0) return;
      clearTimeout(timer);
      if (failed) return reject(failed);
      if (codes.src !== 0) return reject(new Error(`worker tar exited ${codes.src}: ${srcErr.trim()}`));
      if (codes.sink !== 0) return reject(new Error(`tar -x exited ${codes.sink}: ${sinkErr.trim()}`));
      resolve();
    };
    src.on("close", done("src"));
    sink.on("close", done("sink"));
  });
}

/** Delete anything that isn't a plain file or directory. */
async function scrub(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    const st = await lstat(p);
    if (st.isDirectory()) await scrub(p);
    else if (!st.isFile()) await rm(p, { force: true });
  }
}

/** A regular file in an exported directory, or undefined. */
export async function exportedFile(root: string, rel: string): Promise<string | undefined> {
  const p = join(root, rel);
  try {
    return (await lstat(p)).isFile() ? p : undefined;
  } catch {
    return undefined;
  }
}
