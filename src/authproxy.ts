// A loopback proxy in front of api.anthropic.com that holds the real Claude
// credential, so the workers never do.
//
// Workers are Opus agents with a shell, steered by whatever anyone in the
// community typed. Anything their process can read, a prompt injection can
// exfiltrate. If the subscription token sat in a worker's environment it would
// be one `cat /proc/$PPID/environ` away, and CLAUDE_CODE_SUBPROCESS_ENV_SCRUB
// does not help: the CLI itself runs under the same uid as the shell it spawns.
// So a worker gets a random per-task token that is only good here, only while
// its task runs, and only from loopback; this process swaps it for the real one.
import http from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { log } from "./log.ts";

const UPSTREAM = "api.anthropic.com";
const OAUTH_BETA = "oauth-2025-04-20";

// Hop-by-hop headers must not be forwarded (RFC 9110 §7.6.1).
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host"]);

export class AuthProxy {
  #tokens = new Map<string, string>(); // task token -> label
  #server: http.Server;
  #credential: () => string;
  port = 0;

  constructor(credential: () => string) {
    this.#credential = credential;
    this.#server = http.createServer((req, res) => this.#handle(req, res));
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.port = (this.#server.address() as AddressInfo).port;
    log.info(`auth proxy on 127.0.0.1:${this.port}`);
    return this.port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Mint a token for one task. Revoke it when the task ends. */
  issue(label: string): string {
    const token = `sw-${randomBytes(24).toString("hex")}`;
    this.#tokens.set(token, label);
    return token;
  }

  revoke(token: string): void {
    this.#tokens.delete(token);
  }

  #handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const presented = bearer(req) ?? (req.headers["x-api-key"] as string | undefined);
    const label = presented ? this.#tokens.get(presented) : undefined;
    if (!label) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "unknown or revoked task token" } }));
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP.has(k) && k !== "authorization" && k !== "x-api-key" && v !== undefined) headers[k] = v;
    }
    headers.host = UPSTREAM;
    headers.authorization = `Bearer ${this.#credential()}`;
    // A subscription token is an OAuth credential; the API wants it announced.
    const betas = new Set(String(headers["anthropic-beta"] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    betas.add(OAUTH_BETA);
    headers["anthropic-beta"] = [...betas].join(",");

    const upstream = https.request({ host: UPSTREAM, port: 443, method: req.method, path: req.url, headers }, (up) => {
      const out: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) if (!HOP.has(k) && v !== undefined) out[k] = v;
      res.writeHead(up.statusCode ?? 502, out);
      up.pipe(res);
    });
    upstream.on("error", (err) => {
      log.warn(`auth proxy upstream error for ${label}: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream unreachable" } }));
    });
    req.pipe(upstream);
  }
}

function bearer(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}
