// Tasks: one bug fix or feature, from request to PR, and its revisions.
// A JSON file is plenty: there are tens of tasks a day, not thousands.
import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { config } from "./config.ts";

/** "republish": the agent's work is done; only the publishing is to be redone. */
export type TaskStatus = "republish" | "queued" | "running" | "publishing" | "needs_info" | "done" | "failed" | "cancelled" | "declined";

export interface SourceRef {
  channel: string;
  id: string;
  pubkey: string;
  kind: number;
  tags: string[][];
}

export interface Media {
  url: string;
  sha256: string;
  type: string;
  caption: string;
}

export interface Task {
  id: string;
  kind: "bug" | "feature";
  title: string;
  brief: string;
  status: TaskStatus;
  requester: string;
  source: SourceRef;
  createdAt: number;
  updatedAt: number;
  /** Instructions waiting for the worker: the brief, then answers and revisions. */
  pending: string[];
  revision: number;
  sessionId?: string;
  /** The default branch's tip when work began; commits are counted from here. */
  base?: string;
  /** Checkout and worktree deleted. */
  swept?: boolean;
  branch: string;
  nsiteId: string;
  prEventId?: string;
  prUrl?: string;
  previewUrl?: string;
  media: Media[];
  question?: string;
  error?: string;
  /** Our chat messages about this task, so replies to them route back to it. */
  messageIds: string[];
  /** Rough cost the Agent SDK reports (subscription usage, not a bill). */
  costUsd: number;
}

const file = () => `${config.stateDir}/tasks.json`;

export class TaskStore {
  tasks: Task[] = [];
  #writing: Promise<void> = Promise.resolve();

  load(): void {
    if (existsSync(file())) this.tasks = JSON.parse(readFileSync(file(), "utf8"));
    // A restart mid-task: the session survives on disk, so pick it back up.
    for (const t of this.tasks) if (t.status === "running" || t.status === "publishing") t.status = "queued";
  }

  save(): Promise<void> {
    const snapshot = JSON.stringify(this.tasks, null, 2);
    this.#writing = this.#writing.then(async () => {
      await writeFile(`${file()}.tmp`, snapshot);
      await rename(`${file()}.tmp`, file());
    });
    return this.#writing;
  }

  create(fields: Pick<Task, "kind" | "title" | "brief" | "requester" | "source">): Task {
    let id: string;
    do id = randomBytes(3).toString("hex");
    while (this.get(id));
    const now = Date.now();
    const task: Task = {
      ...fields,
      id,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      pending: [fields.brief],
      revision: 0,
      branch: `shipwright/${id}-${slug(fields.title)}`,
      // nsite d tags: ^[a-z0-9-]{1,13}$
      nsiteId: `sw-${id}`,
      media: [],
      messageIds: [],
      costUsd: 0,
    };
    this.tasks.push(task);
    void this.save();
    return task;
  }

  get(id: string): Task | undefined {
    const clean = id.replace(/^#/, "").toLowerCase();
    return this.tasks.find((t) => t.id === clean);
  }

  update(task: Task, patch: Partial<Task>): Task {
    Object.assign(task, patch, { updatedAt: Date.now() });
    void this.save();
    return task;
  }

  /** The task a chat message is about, if it replies to one of our task messages. */
  byMessage(id: string): Task | undefined {
    return this.tasks.find((t) => t.messageIds.includes(id) || t.source.id === id);
  }

  active(): Task[] {
    return this.tasks.filter((t) => ["queued", "republish", "running", "publishing", "needs_info"].includes(t.status));
  }

  recent(limit = 12): Task[] {
    return [...this.tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  startedSince(ms: number, requester?: string): number {
    return this.tasks.filter((t) => t.createdAt >= ms && (!requester || t.requester === requester)).length;
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "change";
}
