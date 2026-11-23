// Turning a finished checkout into things people can look at: media on
// Blossom, a preview nsite, and a pull request on ngit. Everything here runs
// as the service user and is signed with Shipwright's key; the worker only
// ever produced files.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { nip19 } from "nostr-tools";
import { config } from "./config.ts";
import { exportFromWorker, exportedFile, workerPath } from "./handoff.ts";
import { log } from "./log.ts";
import { type Signer, blossomUpload, nsiteUrl } from "./nostr.ts";
import { run, runAsWorker } from "./proc.ts";
import type { Media, Task } from "./tasks.ts";
import { HANDOFF, bundleCommits, checkoutOf, type Report } from "./worker.ts";

const ngit = (args: string[], cwd?: string) =>
  run("ngit", ["--nsec-file", config.keyFile, ...args], { cwd, timeoutMs: 15 * 60_000 });

const MAX_MEDIA = 80 * 1024 * 1024;
const MAX_SITE = 500 * 1024 * 1024;

/** A path the agent gave us, refused unless it is lexically inside .shipwright/. */
function artifact(task: Task, file: string): string | undefined {
  const rel = workerPath(file, ".shipwright");
  if (!rel || rel === ".shipwright" || rel.startsWith(`${HANDOFF}/`)) {
    log.warn(`[${task.id}] ignoring artifact outside .shipwright: ${file}`);
    return undefined;
  }
  return rel;
}

/**
 * WebM doesn't play in Safari; H.264 MP4 plays everywhere. ffmpeg runs as the
 * worker, with the input format pinned: a ".webm" that is really an HLS or
 * concat playlist would otherwise have ffmpeg read any file it names.
 */
async function toMp4(task: Task, rel: string, n: number): Promise<string | undefined> {
  const dir = checkoutOf(task);
  const out = `${HANDOFF}/video-${n}.mp4`;
  try {
    await runAsWorker(task.id, "mkdir", ["-p", `${dir}/${HANDOFF}`]);
    await runAsWorker(
      task.id,
      "ffmpeg",
      ["-y", "-loglevel", "error", "-protocol_whitelist", "file", "-f", "matroska", "-i", `${dir}/${rel}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", "-threads", "4", `${dir}/${out}`],
      { timeoutMs: 10 * 60_000 },
    );
    return out;
  } catch (err) {
    log.warn(`[${task.id}] video conversion failed, uploading the webm: ${(err as Error).message}`);
    return undefined;
  }
}

export async function uploadMedia(task: Task, report: Report, signer: Signer): Promise<Media[]> {
  const out: Media[] = [];
  const items = [...(report.screenshots ?? []).slice(0, 8), ...(report.video ? [report.video] : [])];
  for (const [n, item] of items.entries()) {
    let rel = artifact(task, item.file);
    if (!rel) continue;
    if (rel.endsWith(".webm")) rel = (await toMp4(task, rel, n)) ?? rel;
    let copy: string | undefined;
    try {
      copy = await exportFromWorker(task.id, checkoutOf(task), [rel], MAX_MEDIA);
      const path = await exportedFile(copy, rel);
      if (!path) {
        log.warn(`[${task.id}] artifact is not a regular file: ${item.file}`);
        continue;
      }
      const blob = await blossomUpload(signer, path, config.blossomServers);
      out.push({ url: blob.url, sha256: blob.sha256, type: blob.type, caption: item.caption?.slice(0, 200) ?? "" });
    } catch (err) {
      log.warn(`[${task.id}] media upload failed for ${item.file}: ${(err as Error).message}`);
    } finally {
      if (copy) await rm(copy, { recursive: true, force: true });
    }
  }
  return out;
}

/**
 * Publish the build as a named nsite under Shipwright's key. ngit refuses
 * extensionless files (Apple's site-association file, for one), which a
 * preview doesn't need anyway, so the build is staged without them.
 */
export async function publishPreview(task: Task, dist: string, signer: Signer): Promise<string> {
  // Copied out as the worker: a symlink in the build reaches only what the worker can read.
  const copy = await exportFromWorker(task.id, checkoutOf(task), [dist], MAX_SITE);
  const stage = join(copy, dist);
  try {
    if (!existsSync(join(stage, "index.html"))) throw new Error("the build has no index.html");
    for (const file of await walk(stage)) {
      const name = file.split("/").pop() ?? "";
      if (!name.includes(".") || name.startsWith(".")) await rm(file);
    }
    const res = await ngit(
      [
        "nsite", "publish", stage,
        "--no-config",
        "--id", task.nsiteId,
        "--title", `Armada preview: ${task.title}`.slice(0, 120),
        "--description", `Preview build of Shipwright task ${task.id}, a proposed change to Armada. Not a release.`,
        "--source", config.repo,
        "--fallback", "/index.html",
        ...config.nsiteBlossom.flatMap((s) => ["--blossom-server", s]),
        ...config.nsiteRelays.flatMap((r) => ["--relay", r]),
        "--json",
      ],
      // ngit wants a repository to run in; --no-config keeps it from reading
      // Armada's own .nsite/config.json there.
      config.mirrorDir,
    );
    const out = JSON.parse(res.stdout);
    if (out.command_status && out.command_status !== "success" && out.command_status !== "ok") {
      throw new Error(`nsite publish: ${res.stdout.slice(0, 500)}`);
    }
    const url = nsiteUrl(signer.pubkey, task.nsiteId, config.nsiteGateway);
    await waitForSite(task, url, stage);
    return url;
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

/**
 * Don't post a link before the gateway serves this build: a fresh manifest
 * takes a moment to reach it, and a revision would otherwise show the last
 * one. Compared by hash, because a gateway that mangles bytes (see
 * config.nsiteGateway) still answers 200.
 */
async function waitForSite(task: Task, url: string, dist: string): Promise<void> {
  const want = createHash("sha256").update(await readFile(`${dist}/index.html`)).digest("hex");
  for (let i = 0; i < 36; i++) {
    try {
      const page = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "cache-control": "no-cache" } });
      if (page.ok && createHash("sha256").update(Buffer.from(await page.arrayBuffer())).digest("hex") === want) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 5_000));
  }
  log.warn(`[${task.id}] ${url} did not serve this build within 3 minutes; linking it anyway`);
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const TYPE_LABEL: Record<string, string> = { "bug fix": "🐛 Bug fix", bug: "🐛 Bug fix", feature: "✨ Feature", improvement: "🔧 Improvement" };

export function prDescription(task: Task, report: Report): string {
  const type = TYPE_LABEL[(report.type ?? task.kind).toLowerCase()] ?? TYPE_LABEL[task.kind];
  const parts = [`**${type}** · requested in the Soapbox community on Armada`];
  if (report.impact?.trim()) parts.push(`## What users notice\n\n${report.impact.trim()}`);
  if (task.previewUrl) parts.push(`## Try it\n\n${task.previewUrl}`);
  const images = task.media.filter((m) => m.type.startsWith("image/"));
  const videos = task.media.filter((m) => m.type.startsWith("video/"));
  if (images.length) parts.push(`## Screenshots\n\n${images.map((m) => `![${m.caption.replace(/[[\]]/g, "")}](${m.url})\n${m.caption}`).join("\n\n")}`);
  if (videos.length) parts.push(`## Video\n\n${videos.map((m) => `[${m.caption || "Recording"}](${m.url})`).join("\n\n")}`);
  // Claude Code's own trailer is turned off, but an agent can still write one.
  const summary = (report.summary ?? "").replace(/^.*Generated with \[?Claude Code.*$/gim, "").trim();
  if (summary) parts.push(`## Technical details\n\n${summary}`);
  parts.push(
    `---\n_Opened by Shipwright, an AI agent (${config.workerModelName}). It ran \`npm run test\` before submitting, but it is a machine: please review carefully._`,
  );
  return parts.join("\n\n");
}

/**
 * Open the PR, or add a revision to it. Runs in a worktree of the mirror so
 * ngit sees the nostr:// origin, the default branch, and our commits.
 */
export async function openOrUpdatePr(task: Task, report: Report, base: string): Promise<{ eventId: string; url: string } | undefined> {
  const ref = `refs/shipwright/${task.id}`;
  // Never fetch from the checkout itself (git would run in a repository the
  // agent configured); take a bundle the worker wrote, which is only data.
  const bundle = await bundleCommits(task, base);
  const copy = await exportFromWorker(task.id, checkoutOf(task), [bundle], MAX_SITE);
  try {
    const file = await exportedFile(copy, bundle);
    if (!file) throw new Error("the worker's bundle is missing");
    await run("git", ["-C", config.mirrorDir, "fetch", "--no-tags", file, `+HEAD:${ref}`]);
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
  const wt = `${config.publishDir}/${task.id}`;
  if (!existsSync(wt)) {
    await run("git", ["-C", config.mirrorDir, "worktree", "add", "--detach", wt, ref]);
  }
  await run("git", ["-C", wt, "checkout", "-q", "-B", task.branch, ref]);

  // Revisions keep the title the PR already has (see runner).
  const subject = (task.prEventId ? task.title : report.title ?? task.title).slice(0, 120);
  const description = prDescription(task, report);
  if (!config.openPrs) {
    log.info(`[${task.id}] SHIPWRIGHT_OPEN_PRS is off; would have sent:\n${subject}\n\n${description}`);
    return undefined;
  }
  const args = [
    "send",
    "--defaults",
    "--force-pr",
    // The commit the task started from, not today's main: main keeps moving
    // while a task runs (another task's refresh moves it), and ngit refuses
    // a base the branch doesn't descend from. Two finished tasks were lost
    // to that before their PRs were sent.
    "--base", base,
    "--subject", subject,
    "--description", description,
    "--json",
  ];
  if (task.prEventId) args.push("--in-reply-to", task.prEventId);
  const res = await ngit(args, wt);
  const eventId = findEventId(res.stdout) ?? task.prEventId;
  if (!eventId) throw new Error(`ngit send gave no event id: ${res.stdout.slice(0, 800)}`);
  const rootId = task.prEventId ?? eventId;
  const nevent = nip19.neventEncode({ id: rootId, relays: config.gitRelays.slice(0, 1) });
  return { eventId: rootId, url: `${config.repoWeb}/prs/${nevent}` };
}

/** ngit's JSON has moved between versions; take the first event id it names. */
function findEventId(stdout: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return stdout.match(/\b[0-9a-f]{64}\b/)?.[0];
  }
  const seen: string[] = [];
  const visit = (v: unknown, key = "") => {
    if (typeof v === "string") {
      if (/^[0-9a-f]{64}$/.test(v) && /id|event/i.test(key)) seen.push(v);
      else if (/^nevent1/.test(v)) {
        try {
          seen.push((nip19.decode(v).data as { id: string }).id);
        } catch {}
      }
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  visit(json);
  return seen[0];
}

export async function removePublishWorktree(task: Task): Promise<void> {
  const wt = `${config.publishDir}/${task.id}`;
  if (existsSync(wt)) await run("git", ["-C", config.mirrorDir, "worktree", "remove", "--force", wt]).catch(() => {});
}
