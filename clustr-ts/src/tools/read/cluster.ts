/**
 * Cluster-level reads: replication jobs and the recent cluster log — both cheap
 * endpoints the UI surfaces directly.
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

const when = (epoch?: number): string =>
  epoch ? new Date(epoch * 1000).toISOString().replace("T", " ").slice(0, 19) : "—";

export function register(server: McpServer): void {
  server.registerTool(
    "list_replication",
    {
      title: "List Replication Jobs",
      description:
        "List storage-replication jobs configured in the cluster (guest, target " +
        "node, schedule). Empty if you don't use replication.",
      annotations: READ,
    },
    async () =>
      safe("list_replication", async () => {
        const jobs = (await proxmoxGet("/cluster/replication")) as Record<
          string,
          any
        >[];
        if (!jobs.length) return "No replication jobs configured.";
        const lines = [`## Replication jobs (${jobs.length})\n`];
        for (const j of jobs) {
          const off = j.disable ? " (disabled)" : "";
          lines.push(
            `- **${j.id}**${off} — guest ${j.guest} → ${j.target} · schedule ${j.schedule ?? "—"}`,
          );
        }
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "get_cluster_log",
    {
      title: "Get Cluster Log",
      description:
        "Recent cluster-wide log events (the Datacenter → Cluster log). Useful " +
        "for 'what happened recently' beyond just failed tasks.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .describe("Max entries (default 50)"),
      },
      annotations: READ,
    },
    async ({ limit }) =>
      safe("get_cluster_log", async () => {
        const rows = (await proxmoxGet("/cluster/log", { max: limit })) as Record<
          string,
          any
        >[];
        if (!rows.length) return "No recent cluster log entries.";
        const lines = [`## Cluster log (${rows.length})\n`];
        for (const r of rows) {
          const sev = (r.pri ?? 6) <= 3 ? "🔴" : (r.pri ?? 6) <= 4 ? "🟠" : "·";
          lines.push(
            `${sev} ${when(r.time)} [${r.node ?? "?"}/${r.tag ?? r.user ?? "?"}] ${r.msg ?? ""}`,
          );
        }
        return lines.join("\n");
      }),
  );
}
