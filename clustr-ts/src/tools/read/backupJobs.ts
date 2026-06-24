/**
 * Read the scheduled backup *jobs* (Datacenter → Backup) from /cluster/backup:
 * the small, instant job-config endpoint. This is the fast way to answer "which
 * guests are backed up on a schedule", versus enumerating actual archives
 * (which, on a PBS datastore, forces a slow walk of the chunk store).
 *
 * Exports helpers so cluster_review can reuse the same cheap coverage data
 * instead of walking archives.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { proxmoxGet } from "../../proxmox.js";
import { safe } from "../../safe.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

export interface BackupJob {
  id?: string;
  enabled?: number;
  schedule?: string;
  dow?: string;
  starttime?: string;
  storage?: string;
  mode?: string;
  all?: number;
  vmid?: string;
  pool?: string;
  exclude?: string;
  comment?: string;
  "next-run"?: number;
}

export async function getBackupJobs(): Promise<BackupJob[]> {
  return (await proxmoxGet("/cluster/backup")) as BackupJob[];
}

const idList = (csv?: string): number[] =>
  String(csv ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

const isEnabled = (j: BackupJob): boolean => j.enabled !== 0;

export interface Coverage {
  all: boolean;
  allExcludes: Set<number>;
  vmids: Set<number>;
  hasPoolJob: boolean;
}

/** Which guests do the *enabled* jobs cover, derived from job config alone. */
export function jobCoverage(jobs: BackupJob[]): Coverage {
  const c: Coverage = {
    all: false,
    allExcludes: new Set(),
    vmids: new Set(),
    hasPoolJob: false,
  };
  for (const j of jobs) {
    if (!isEnabled(j)) continue;
    if (j.all) {
      c.all = true;
      idList(j.exclude).forEach((v) => c.allExcludes.add(v));
    }
    idList(j.vmid).forEach((v) => c.vmids.add(v));
    if (j.pool) c.hasPoolJob = true;
  }
  return c;
}

function scheduleOf(j: BackupJob): string {
  if (j.schedule) return j.schedule;
  if (j.dow || j.starttime) return `${j.dow ?? ""} ${j.starttime ?? ""}`.trim();
  return "—";
}

function targetOf(j: BackupJob): string {
  if (j.all) return `all guests${j.exclude ? ` (except ${j.exclude})` : ""}`;
  if (j.pool) return `pool '${j.pool}'`;
  if (j.vmid) return `guests ${j.vmid}`;
  return "—";
}

function whenOf(epoch?: number): string {
  return epoch
    ? new Date(epoch * 1000).toISOString().replace("T", " ").slice(0, 16)
    : "";
}

export function register(server: McpServer): void {
  server.registerTool(
    "list_backup_jobs",
    {
      title: "List Backup Jobs",
      description:
        "List the scheduled backup jobs from Datacenter → Backup (reads the " +
        "/cluster/backup job config, instant, unlike enumerating archives). " +
        "Shows each job's schedule, target storage, what it covers (all / " +
        "specific guests / pool, minus exclusions), mode, and enabled state: " +
        "the fast way to answer 'which guests have a scheduled backup'.",
      annotations: READ,
    },
    async () =>
      safe("list_backup_jobs", async () => {
        const jobs = await getBackupJobs();
        if (!jobs.length) {
          return "No scheduled backup jobs configured (Datacenter → Backup is empty).";
        }
        const lines = [`## Backup jobs (${jobs.length})\n`];
        for (const j of jobs) {
          const state = isEnabled(j) ? "✅ enabled" : "⚫ disabled";
          const next = j["next-run"] ? ` · next ${whenOf(j["next-run"])}` : "";
          lines.push(
            `${state} **${j.id ?? "job"}** - ${scheduleOf(j)} → ${j.storage ?? "?"} (${j.mode ?? "snapshot"})\n` +
              `   covers: ${targetOf(j)}${next}` +
              (j.comment ? `\n   ${j.comment}` : ""),
          );
        }
        return lines.join("\n");
      }),
  );
}
