// Schedules tasks onto worker slots and carries each through the pipeline:
// checkout → agent → build → preview → media → PR → chat.
import type { AuthProxy } from "./authproxy.ts";
import type { Chat } from "./chat.ts";
import { config } from "./config.ts";
import { log } from "./log.ts";
import type { Signer } from "./nostr.ts";
import { openOrUpdatePr, publishPreview, removePublishWorktree, uploadMedia } from "./publish.ts";
import type { Task, TaskStore } from "./tasks.ts";
import { buildPreview, inspectCheckout, prepareCheckout, readReport, refreshMirror, removeCheckout, runAgent, type Report } from "./worker.ts";

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
    const waiting = this.tasks.tasks.filter((t) => t.status === "queued" || t.status === "republish").sort((a, b) => a.updatedAt - b.updatedAt);
    for (const task of waiting) {
      if (this.#running.size >= config.maxParallel) return;
      if (this.#running.has(task.id)) continue;
      const used = new Set([...this.#running.values()].map((r) => r.slot));
      let slot = 0;
      while (used.has(slot)) slot++;
      const abort = new AbortController();
      this.#running.set(task.id, { abort, slot });
      const job = task.status === "republish" ? this.republish(task) : this.#execute(task, slot, abort);
      void job.finally(() => {
        this.#running.delete(task.id);
        this.kick();
      });
    }
  }

  position(task: Task): number {
    return this.tasks.tasks.filter((t) => t.status === "queued" && t.updatedAt <= task.updatedAt).length;
  }

  revise(task: Task, text: string, announce: boolean): void {
    this.tasks.update(task, { pending: [...task.pending, text], status: "queued", question: undefined, error: undefined, announce: announce || !task.prEventId });
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
        await this.#say(task, `Quick question first: ${report.question ?? report.chat_summary ?? "could you say a bit more?"}`);
        return;
      }
      if (report.status === "declined") {
        // Silent: the only thing people hear about a task is its pull request.
        this.tasks.update(task, { status: "declined", error: report.reason });
        log.info(`[${task.id}] declined: ${report.reason ?? report.chat_summary}`);
        return;
      }

      await this.#publish(task, base, report);
    } catch (err) {
      this.#failed(task, err);
    }
  }

  /**
   * Publish finished work again without re-running the agent: for a task
   * whose agent finished but whose preview or PR step failed.
   */
  async republish(task: Task): Promise<void> {
    try {
      const report = await readReport(task);
      if (report?.status !== "done") throw new Error(`#${task.id} has no finished report to publish`);
      if (!task.base) throw new Error(`#${task.id} has no base commit`);
      await this.#publish(task, task.base, report);
    } catch (err) {
      this.#failed(task, err);
    }
  }

  #failed(task: Task, err: unknown): void {
    const message = (err as Error).message;
    const spent = (err as { costUsd?: number }).costUsd;
    if (spent) this.tasks.update(task, { costUsd: task.costUsd + spent });
    log.error(`[${task.id}] failed: ${message}`);
    if ((task.status as string) === "cancelled") return;
    // Silent: a failure is for the maintainers, who have the logs.
    this.tasks.update(task, { status: "failed", error: message.slice(0, 2000) });
  }

  async #publish(task: Task, base: string, report: Report): Promise<void> {
    {
      const { commits, dirty } = await inspectCheckout(task, base);
      if (commits === 0) throw new Error("the agent reported success but committed nothing");
      if (dirty) log.warn(`[${task.id}] uncommitted files left behind:\n${dirty}`);

      // A revision keeps the PR's title: the worker rewrites it from the
      // code's side, and a good title once overwritten is gone.
      this.tasks.update(task, { status: "publishing", title: task.prEventId ? task.title : report.title?.trim() || task.title });
      const dist = await buildPreview(task);
      const previewUrl = await publishPreview(task, dist, this.signer).catch((err) => {
        log.warn(`[${task.id}] preview publish failed: ${err.message}`);
        return task.previewUrl;
      });
      const media = await uploadMedia(task, report, this.signer);
      this.tasks.update(task, { previewUrl, media });
      const pr = await openOrUpdatePr(task, report, base);
      const announce = task.announce ?? true;
      this.tasks.update(task, { status: "done", prEventId: pr?.eventId ?? task.prEventId, prUrl: pr?.url ?? task.prUrl, revision: task.revision + 1, announce: false });
      if (!announce) {
        log.info(`[${task.id}] revised quietly (nobody asked Shipwright for it directly)`);
        return;
      }
      // One casual sentence and two links. Screenshots stay in the PR: in chat
      // Armada folds them away anyway, and the links say everything.
      const links = [task.prUrl && `[PR](${task.prUrl})`, previewUrl && `[preview](${previewUrl})`].filter(Boolean).join(" · ");
      const summary = report.chat_summary?.trim() || (task.revision > 1 ? "Updated." : "Done.");
      await this.#say(task, `${summary} ${links}`.trim());
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

