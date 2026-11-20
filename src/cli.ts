// Maintenance commands, run on the server as the service user:
//
//   sudo -u shipwright -H bash -c 'set -a; . /etc/shipwright/env; cd /opt/shipwright/app && node src/cli.ts <command>'
//
//   tasks                         list tasks
//   show <id>                     one task in full
//   run --title T --brief B [--kind bug|feature]
//                                 run a task start to finish without chat
//                                 (set SHIPWRIGHT_OPEN_PRS=0 to stop short of the PR)
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { AuthProxy } from "./authproxy.ts";
import type { Chat } from "./chat.ts";
import { config } from "./config.ts";
import { loadOrCreateKey } from "./identity.ts";
import { Runner } from "./runner.ts";
import { TaskStore } from "./tasks.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { title: { type: "string" }, brief: { type: "string" }, kind: { type: "string", default: "feature" } },
});
const tasks = new TaskStore();
tasks.load();

switch (positionals[0]) {
  case "tasks":
    for (const t of tasks.recent(50)) console.log(`#${t.id} ${t.status.padEnd(10)} ${t.kind.padEnd(7)} ${t.title}${t.prUrl ? `  ${t.prUrl}` : ""}`);
    break;
  case "show": {
    const t = tasks.get(positionals[1] ?? "");
    console.log(t ? JSON.stringify(t, null, 2) : "no such task");
    break;
  }
  case "run": {
    if (!values.title || !values.brief) throw new Error("--title and --brief are required");
    const signer = await loadOrCreateKey();
    const proxy = new AuthProxy(() => readFileSync(config.claudeTokenFile, "utf8").trim());
    await proxy.listen();
    // No chat: the runner logs what it would have said.
    const chat = { post: async (_c: string, text: string) => (console.log(`[chat] ${text}`), "0".repeat(64)) } as unknown as Chat;
    const runner = new Runner({ tasks, chat, proxy, signer });
    const task = tasks.create({
      kind: values.kind === "bug" ? "bug" : "feature",
      title: values.title,
      brief: values.brief,
      requester: signer.pubkey,
      source: { channel: "", id: "0".repeat(64), pubkey: signer.pubkey, kind: 9, tags: [] },
    });
    console.log(`running #${task.id}`);
    runner.kick();
    while (["queued", "running", "publishing"].includes(task.status)) await new Promise((r) => setTimeout(r, 5_000));
    await tasks.save();
    console.log(JSON.stringify({ status: task.status, previewUrl: task.previewUrl, prUrl: task.prUrl, media: task.media, error: task.error, costUsd: task.costUsd }, null, 2));
    process.exit(0);
  }
  default:
    console.log("commands: tasks | show <id> | run --title T --brief B [--kind bug|feature]");
}
