// Schedules tasks onto worker slots and carries each through the pipeline:
// checkout → agent → build → preview → media → PR → chat.
import type { AuthProxy } from "./authproxy.ts";
import type { Chat } from "./chat.ts";
import { config } from "./config.ts";
import { log } from "./log.ts";
import type { Signer } from "./nostr.ts";
import { openOrUpdatePr, publishPreview, removePublishWorktree, uploadMedia } from "./publish.ts";
import type { Task, TaskStore } from "./tasks.ts";
import { buildPreview, inspectCheckout, prepareCheckout, refreshMirror, removeCheckout, runAgent } from "./worker.ts";

export class Runner {
  tasks: TaskStore;
  chat: Chat;
  proxy: AuthProxy;
  signer: Signer;
  #running = new Map<string, { abort: AbortController; slot: number }>();

  constructor(deps: { tasks: TaskStore; chat: Chat; proxy: AuthProxy; signer: Signer }) {
    this.tasks = deps.tasks;
    this.chat = deps.chat;
    this.proxy = deps.proxy;
    this.signer = deps.signer;
  }

  /** Start whatever fits in the free slots, oldest first. */
  kick(): void {
    const queued = this.tasks.tasks.filter((t) => t.status === "queued").sort((a, b) => a.updatedAt - b.updatedAt);
    for (const task of queued) {
      if (this.#running.size >= config.maxParallel) return;
      if (this.#running.has(task.id)) continue;
      const used = new Set([...this.#running.values()].map((r) => r.slot));
      let slot = 0;
      while (used.has(slot)) slot++;
      const abort = new AbortController();
      this.#running.set(task.id, { abort, slot });
      void this.#execute(task, slot, abort).finally(() => {
        this.#running.delete(task.id);
        this.kick();
      });
    }
  }

  position(task: Task): number {
    return this.tasks.tasks.filter((t) => t.status === "queued" && t.updatedAt <= task.updatedAt).length;
  }

  revise(task: Task, text: string): void {
    this.tasks.update(task, { pending: [...task.pending, text], status: "queued", question: undefined, error: undefined });
    this.kick();
  }

  cancel(task: Task): void {
    this.#running.get(task.id)?.abort.abort();
    this.tasks.update(task, { status: "cancelled" });
  }

  async #say(task: Task, text: string, media: Task["media"] = []): Promise<void> {
    try {
      const id = await this.chat.post(task.source.channel, text, { replyTo: task.source, media });
      this.tasks.update(task, { messageIds: [...task.messageIds, id] });
    } catch (err) {
      log.warn(`[${task.id}] could not post to chat: ${(err as Error).message}`);
    }
  }

  async #execute(task: Task, slot: number, abort: AbortController): Promise<void> {
    const t0 = Date.now();
    try {
      this.tasks.update(task, { status: "running" });
      const base = task.base ?? (await refreshMirror());
      if (!task.base) this.tasks.update(task, { base });
      await prepareCheckout(task, base);
      log.info(`[${task.id}] agent starting (${task.sessionId ? "resumed" : "new"}, slot ${slot})`);
      const outcome = await runAgent(task, this.proxy, config.devPortBase + slot, abort);
      this.tasks.update(task, { sessionId: outcome.sessionId, costUsd: task.costUsd + outcome.costUsd, pending: [] });
      if ((task.status as string) === "cancelled") return;
      const { report } = outcome;
      log.info(`[${task.id}] agent reported ${report.status} after ${Math.round((Date.now() - t0) / 60_000)} min`);

      if (report.status === "needs_info") {
        this.tasks.update(task, { status: "needs_info", question: report.question });
        await this.#say(task, `❓ A question about #${task.id} before I go further: ${report.question ?? report.chat_summary ?? "could you say more?"}\n\nReply to this message and I'll pick it back up.`);
        return;
      }
      if (report.status === "declined") {
        // Silent: the only thing people hear about a task is its pull request.
        this.tasks.update(task, { status: "declined", error: report.reason });
        log.info(`[${task.id}] declined: ${report.reason ?? report.chat_summary}`);
        return;
      }

      const { commits, dirty } = await inspectCheckout(task, base);
      if (commits === 0) throw new Error("the agent reported success but committed nothing");
      if (dirty) log.warn(`[${task.id}] uncommitted files left behind:\n${dirty}`);

      this.tasks.update(task, { status: "publishing", title: report.title?.trim() || task.title });
      const dist = await buildPreview(task);
      const previewUrl = await publishPreview(task, dist, this.signer).catch((err) => {
        log.warn(`[${task.id}] preview publish failed: ${err.message}`);
        return task.previewUrl;
      });
      const media = await uploadMedia(task, report, this.signer);
      this.tasks.update(task, { previewUrl, media });
      const pr = await openOrUpdatePr(task, report);
      const firstPr = !task.prEventId;
      this.tasks.update(task, { status: "done", prEventId: pr?.eventId ?? task.prEventId, prUrl: pr?.url ?? task.prUrl, revision: task.revision + 1 });

      const lines = [
        firstPr ? `✅ #${task.id} is ready for review: ${task.title}` : `🔁 Updated #${task.id}: ${task.title}`,
        report.chat_summary?.trim() ?? "",
        previewUrl ? `🔎 Try it: ${previewUrl}` : "",
        task.prUrl ? `🔀 Pull request: ${task.prUrl}` : "",
        ...media.map((m) => m.url),
        firstPr ? "\nReply here if it's not quite right and I'll revise it." : "",
      ];
      await this.#say(task, lines.filter(Boolean).join("\n"), media);
    } catch (err) {
      const message = (err as Error).message;
      log.error(`[${task.id}] failed: ${message}`);
      if ((task.status as string) === "cancelled") return;
      // Silent too: a failure is for the maintainers, who have the logs.
      this.tasks.update(task, { status: "failed", error: message.slice(0, 2000) });
    }
  }

  /** Delete checkouts of tasks finished more than a week ago. */
  async sweep(): Promise<void> {
    const cutoff = Date.now() - 7 * 24 * 3600_000;
    for (const task of this.tasks.tasks) {
      if (["done", "failed", "cancelled", "declined"].includes(task.status) && task.updatedAt < cutoff && !task.swept) {
        await removeCheckout(task);
        await removePublishWorktree(task);
        this.tasks.update(task, { swept: true });
      }
    }
  }
}

