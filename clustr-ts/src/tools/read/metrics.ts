/**
 * get_metrics_history: RRD performance history (the UI graphs). Turns a
 * point-in-time reading into a trend: "RAM has been pinned at 90% for days"
 * instead of "RAM is 90% right now". Reads /…/rrddata and summarizes avg/peak.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxmoxGet } from "../../proxmox.js";
import { safe } from "../../safe.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

type Point = Record<string, number | undefined>;

/** avg & peak of a series, ignoring undefined samples. */
function stat(points: Point[], key: string): { avg: number; peak: number } {
  const vals = points.map((p) => p[key]).filter((v): v is number => typeof v === "number");
  if (!vals.length) return { avg: 0, peak: 0 };
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { avg, peak: Math.max(...vals) };
}

const pct = (frac: number): number => Math.round(frac * 100 * 10) / 10;
const ratioPct = (used: number, total: number): number =>
  total > 0 ? Math.round((used / total) * 1000) / 10 : 0;

/** Summarize one rrddata series for node or guest (field names differ). */
export async function metricsSummary(
  path: string,
  timeframe: string,
  isNode: boolean,
): Promise<string> {
  const points = (await proxmoxGet(path, { timeframe, cf: "AVERAGE" })) as Point[];
  if (!points.length) return "No metric history available for this timeframe.";

  const cpu = stat(points, "cpu");
  const memUsedKey = isNode ? "memused" : "mem";
  const memTotalKey = isNode ? "memtotal" : "maxmem";
  // mem% per sample, then avg/peak of the percentages
  const memPctSeries: Point[] = points.map((p) => ({
    m: ratioPct(Number(p[memUsedKey] ?? 0), Number(p[memTotalKey] ?? 0)),
  }));
  const mem = stat(memPctSeries, "m");
  const netin = stat(points, "netin");
  const netout = stat(points, "netout");

  return [
    `Over the last **${timeframe}** (${points.length} samples):`,
    `- CPU: avg ${pct(cpu.avg)}% · peak ${pct(cpu.peak)}%`,
    `- Memory: avg ${mem.avg.toFixed(1)}% · peak ${mem.peak.toFixed(1)}%`,
    `- Net: avg ↓${Math.round(netin.avg / 1024)} / ↑${Math.round(netout.avg / 1024)} KB/s` +
      ` · peak ↓${Math.round(netin.peak / 1024)} / ↑${Math.round(netout.peak / 1024)} KB/s`,
  ].join("\n");
}

export function register(server: McpServer): void {
  server.registerTool(
    "get_metrics_history",
    {
      title: "Get Metrics History (Trend)",
      description:
        "Get CPU/memory/network history (the RRD data behind the UI graphs) for a " +
        "node, VM, or container, summarized as average and peak over a timeframe. " +
        "Use this to tell whether something has been sustained (e.g. RAM pinned " +
        "for days) versus a momentary spike.",
      inputSchema: {
        node: z.string().describe("Node name (e.g. 'pve')"),
        kind: z
          .enum(["node", "vm", "container"])
          .describe("What to measure"),
        vmid: z
          .number()
          .int()
          .min(100)
          .optional()
          .describe("VM/container ID (required when kind is vm or container)"),
        timeframe: z
          .enum(["hour", "day", "week", "month", "year"])
          .default("day")
          .describe("History window. Default: day."),
      },
      annotations: READ,
    },
    async ({ node, kind, vmid, timeframe }) =>
      safe("get_metrics_history", async () => {
        let path: string;
        let isNode = false;
        if (kind === "node") {
          path = `/nodes/${node}/rrddata`;
          isNode = true;
        } else {
          if (vmid === undefined) {
            return "Provide a vmid for a VM or container.";
          }
          const seg = kind === "vm" ? "qemu" : "lxc";
          path = `/nodes/${node}/${seg}/${vmid}/rrddata`;
        }
        const target = kind === "node" ? node : `${kind} ${vmid} on ${node}`;
        return `## Metrics - ${target}\n\n${await metricsSummary(path, timeframe, isNode)}`;
      }),
  );
}
