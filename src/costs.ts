// What Shipwright spends, one JSON line per model run. The figures are the
// Agent SDK's API-equivalent prices: on a subscription nothing is billed per
// run, so read them as "how much of the plan's limits this used".
import { appendFile, readFile } from "node:fs/promises";
import { config } from "./config.ts";
import { log } from "./log.ts";

export interface CostEntry {
  ts: number;
  kind: "coordinator" | "worker";
  usd: number;
  model: string;
  task?: string;
}

const file = () => `${config.stateDir}/costs.jsonl`;

/** One short line per entry: appends from one process don't interleave. */
export async function recordCost(entry: Omit<CostEntry, "ts">): Promise<void> {
  if (!(entry.usd > 0)) return;
  try {
    await appendFile(file(), `${JSON.stringify({ ts: Date.now(), ...entry })}\n`);
  } catch (err) {
    log.warn(`recording cost: ${(err as Error).message}`);
  }
}

export async function readCosts(): Promise<CostEntry[]> {
  let raw = "";
  try {
    raw = await readFile(file(), "utf8");
  } catch {
    return [];
  }
  const out: CostEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {} // a torn last line from a crash costs one entry, not the report
  }
  return out;
}
