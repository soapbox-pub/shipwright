// The concord-io child process: Shipwright's membership in the community.
// It is restarted with backoff if it dies; nothing here holds Concord state.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { config } from "./config.ts";
import { log } from "./log.ts";

export interface Channel {
  id: string;
  name: string;
  private: boolean;
  forum: boolean;
  view: string | null;
  category: string | null;
}

export interface ChatMessage {
  channel: string;
  channel_name: string;
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  tags: string[][];
  ms: number;
  moderator: boolean;
}

export interface Ready {
  self: string;
  community: { id: string; name: string; owner: string; relays: string[] };
  channels: Channel[];
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class ConcordIO extends EventEmitter {
  #child?: ChildProcessWithoutNullStreams;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #backoff = 5_000;
  #stopping = false;
  ready?: Ready;

  start(): void {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      CONCORD_IO_KEY_FILE: config.keyFile,
      CONCORD_IO_STATE_DIR: `${config.stateDir}/concord`,
      RUST_LOG: process.env.CONCORD_IO_LOG ?? "info,relay_pool=warn",
    };
    if (config.invite) env.CONCORD_IO_INVITE = config.invite;
    const child = spawn(config.concordIo, [], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;
    createInterface({ input: child.stderr }).on("line", (line) => log.info(`[concord] ${line.replace(/^\S+\s+/, "")}`));
    createInterface({ input: child.stdout }).on("line", (line) => this.#line(line));
    child.on("exit", (code, signal) => {
      this.#child = undefined;
      for (const [, p] of this.#pending) p.reject(new Error("concord-io exited"));
      this.#pending.clear();
      if (this.#stopping) return;
      log.warn(`concord-io exited (${code ?? signal}); restarting in ${this.#backoff / 1000}s`);
      setTimeout(() => this.start(), this.#backoff);
      this.#backoff = Math.min(this.#backoff * 2, 300_000);
    });
  }

  stop(): void {
    this.#stopping = true;
    this.#child?.kill("SIGTERM");
  }

  #line(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      log.warn(`concord-io said something that isn't JSON: ${line.slice(0, 200)}`);
      return;
    }
    switch (msg.type) {
      case "ready":
        this.#backoff = 5_000;
        this.ready = msg;
        this.emit("ready", msg as Ready);
        break;
      case "channels":
        if (this.ready) this.ready.channels = msg.channels;
        this.emit("channels", msg.channels as Channel[]);
        break;
      case "message":
        this.emit("message", msg as ChatMessage);
        break;
      case "excluded":
        log.error("removed from the community by a Refounding");
        this.emit("excluded");
        break;
      case "result": {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg);
        else p.reject(new Error(msg.error ?? "concord-io command failed"));
        break;
      }
    }
  }

  request<T = any>(op: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    const child = this.#child;
    if (!child) return Promise.reject(new Error("concord-io is not running"));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`concord-io ${op} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
  }

  send(channel: string, content: string, opts: { kind?: number; tags?: string[][] } = {}): Promise<{ rumor_id: string }> {
    return this.request("send", { channel, content, kind: opts.kind ?? 9, tags: opts.tags ?? [] });
  }

  typing(channel: string): void {
    this.request("typing", { channel }).catch(() => {});
  }

  async history(channel: string, limit = 150): Promise<Omit<ChatMessage, "channel" | "channel_name" | "moderator">[]> {
    const r = await this.request<{ messages: any[] }>("history", { channel, limit }, 90_000);
    return r.messages;
  }
}
