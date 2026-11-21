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

/**
 * Run a command as shipwright-worker, through as-worker's clean environment.
 * Only the VAR=value pairs given here reach it.
 */
export function runAsWorker(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const envPairs = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`);
  if (config.asWorker.length === 0) return run(cmd, args, opts); // local development
  const [sudo, ...rest] = config.asWorker;
  return run(sudo, [...rest, ...envPairs, "--", cmd, ...args], { ...opts, env: {} });
}

export function workerCommand(cmd: string, args: string[], env: Record<string, string>): { command: string; args: string[] } {
  const envPairs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  if (config.asWorker.length === 0) return { command: "env", args: [...envPairs, cmd, ...args] };
  const [sudo, ...rest] = config.asWorker;
  return { command: sudo, args: [...rest, ...envPairs, "--", cmd, ...args] };
}
