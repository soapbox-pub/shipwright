import { spawn } from "node:child_process";
import { config } from "./config.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Throw on a non-zero exit (default true). */
  check?: boolean;
  input?: string;
  /** Run under this umask instead of the service's. */
  umask?: string;
}

const TAIL = 64 * 1024;

/**
 * Tools that answer in JSON (ngit --json) put the reason for a failure on
 * stdout and only progress on stderr; an error message built from stderr
 * alone said nothing at all.
 */
function verdict(stdout: string): string | undefined {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const j = JSON.parse(line);
      const why = j?.error?.message ?? j?.error ?? (j?.level === "error" ? j.message : undefined);
      if (why) return typeof why === "string" ? why : JSON.stringify(why);
    } catch {}
  }
  try {
    const j = JSON.parse(stdout);
    const why = j?.error?.message ?? j?.error;
    if (why) return typeof why === "string" ? why : JSON.stringify(why);
  } catch {}
  return undefined;
}

/** Run a command as the service user. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const [file, argv] = opts.umask ? ["sh", ["-c", `umask ${opts.umask} && exec "$0" "$@"`, cmd, ...args]] : [cmd, args];
    const child = spawn(file, argv, {
      cwd: opts.cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", LANG: "C.UTF-8", ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: opts.timeoutMs ?? 30 * 60_000,
      killSignal: "SIGTERM",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout = (stdout + d).slice(-TAIL)));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-TAIL)));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? -1, stdout, stderr };
      if ((opts.check ?? true) && result.code !== 0) {
        reject(new Error(`${cmd} ${args.slice(0, 4).join(" ")} exited ${result.code}: ${verdict(stdout) ?? (stderr || stdout).trim().slice(-1500)}`));
      } else resolve(result);
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export interface WorkerOptions extends RunOptions {
  /**
   * Set up a fresh checkout of the default branch: the shared cache
   * (Playwright's browsers, npm's downloads) is writable. Only before an
   * agent has touched the checkout; otherwise everything it runs could
   * poison every later task's dependencies.
   */
  prepare?: boolean;
}

/** What as-worker takes before the command: the task, the mode, the environment. */
function workerArgs(task: string, env: Record<string, string>, prepare = false): string[] {
  return [task, ...(prepare ? ["--prepare"] : []), ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "--"];
}

/**
 * Run a command as shipwright-worker, in the task's sandbox (deploy/as-worker):
 * it can write to that task's checkout, home and tmp and nothing else, and
 * only the VAR=value pairs given here reach it.
 */
export function runAsWorker(task: string, cmd: string, args: string[], opts: WorkerOptions = {}): Promise<RunResult> {
  if (config.asWorker.length === 0) return run(cmd, args, opts); // local development
  const [sudo, ...rest] = config.asWorker;
  return run(sudo, [...rest, ...workerArgs(task, opts.env ?? {}, opts.prepare), cmd, ...args], { ...opts, env: {} });
}

export function workerCommand(task: string, cmd: string, args: string[], env: Record<string, string>): { command: string; args: string[] } {
  if (config.asWorker.length === 0) return { command: "env", args: [...Object.entries(env).map(([k, v]) => `${k}=${v}`), cmd, ...args] };
  const [sudo, ...rest] = config.asWorker;
  return { command: sudo, args: [...rest, ...workerArgs(task, env), cmd, ...args] };
}

/** Delete a task's checkout and scratch, keeping its Claude sessions (see as-worker). */
export async function removeWorkerFiles(task: string, dir: string): Promise<void> {
  if (config.asWorker.length === 0) {
    await run("rm", ["-rf", dir]);
    return;
  }
  const [sudo, ...rest] = config.asWorker;
  await run(sudo, [...rest, task, "--remove"], { env: {} });
}
