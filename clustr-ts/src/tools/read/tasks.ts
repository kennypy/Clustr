/**
 * Read-only tools for following Proxmox tasks (UPIDs).
 *
 * Every write tool returns a `Task ID: UPID:...`; these let you answer the
 * obvious follow-ups, "is it done?", "did it fail and why?", instead of the
 * UPID being a dead end. The node is parsed out of the UPID, so the caller only
 * needs to paste the UPID a write tool already gave them.
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

/** UPID format: UPID:<node>:<pid>:<pstart>:<starttime>:<type>:<id>:<user>: */
export function nodeFromUpid(upid: string): string {
  const parts = upid.split(":");
  if (parts[0] !== "UPID" || !parts[1]) {
    throw new Error(
      `'${upid}' is not a valid task UPID (expected 'UPID:<node>:...'). ` +
        "Use the Task ID a write tool returned.",
    );
  }
  return parts[1];
}

function when(epoch?: number): string {
  return epoch
    ? new Date(epoch * 1000).toISOString().replace("T", " ").slice(0, 19)
    : "—";
}

export function register(server: McpServer): void {
  server.registerTool(
    "list_tasks",
    {
      title: "List Recent Tasks",
      description:
        "List recent Proxmox tasks on a node (backups, creates, migrations, etc.) " +
        "with their type, target, status, and time. Good for 'what just ran / what " +
        "failed'.",
      inputSchema: {
        node: z.string().describe("Node name (e.g. 'pve')"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .describe("Max tasks to return (default 50)"),
        errors_only: z
          .boolean()
          .default(false)
          .describe("Only show tasks that ended in error"),
      },
      annotations: READ,
    },
    async ({ node, limit, errors_only }) =>
      safe("list_tasks", async () => {
        const rows = (await proxmoxGet(`/nodes/${node}/tasks`, {
          limit,
          errors: errors_only ? 1 : 0,
        })) as Record<string, any>[];
        if (!rows.length) return `No recent tasks on ${node}.`;
        const lines = [`## Recent tasks on ${node} (${rows.length})\n`];
        for (const t of rows) {
          const running = !t.endtime;
          const ok = t.status === "OK";
          const icon = running ? "⏳" : ok ? "✅" : "❌";
          const state = running
            ? "running"
            : ok
              ? "OK"
              : `error: ${t.status}`;
          lines.push(
            `${icon} **${t.type}**${t.id ? ` ${t.id}` : ""} - ${state}\n` +
              `   ${when(t.starttime)} · ${t.user ?? ""}\n` +
              `   \`${t.upid}\``,
          );
        }
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "get_task_status",
    {
      title: "Get Task Status",
      description:
        "Get the status of a Proxmox task by its UPID (the Task ID returned by " +
        "create/delete/backup/restore/power tools). Tells you if it's running, " +
        "finished OK, or failed.",
      inputSchema: {
        upid: z.string().describe("Task UPID, e.g. 'UPID:pve:....'"),
      },
      annotations: READ,
    },
    async ({ upid }) =>
      safe("get_task_status", async () => {
        const node = nodeFromUpid(upid);
        const s = (await proxmoxGet(
          `/nodes/${node}/tasks/${upid}/status`,
        )) as Record<string, any>;
        const running = s.status === "running";
        const ok = s.exitstatus === "OK";
        const icon = running ? "⏳" : ok ? "✅" : "❌";
        const state = running
          ? "running"
          : ok
            ? "finished OK"
            : `failed - ${s.exitstatus ?? "unknown"}`;
        return [
          `## Task ${icon} ${state}\n`,
          `**Type:** ${s.type ?? "?"}${s.id ? ` (${s.id})` : ""}`,
          `**Node:** ${node}`,
          `**User:** ${s.user ?? "?"}`,
          `**Started:** ${when(s.starttime)}`,
          running
            ? ""
            : "\nIf it failed, use `get_task_log` with the same UPID to see why.",
        ]
          .filter(Boolean)
          .join("\n");
      }),
  );

  server.registerTool(
    "get_task_log",
    {
      title: "Get Task Log",
      description:
        "Get the log output of a Proxmox task by its UPID, use this to see why a " +
        "backup/restore/create/migration failed.",
      inputSchema: {
        upid: z.string().describe("Task UPID, e.g. 'UPID:pve:....'"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(200)
          .describe("Max log lines (default 200)"),
      },
      annotations: READ,
    },
    async ({ upid, limit }) =>
      safe("get_task_log", async () => {
        const node = nodeFromUpid(upid);
        const rows = (await proxmoxGet(`/nodes/${node}/tasks/${upid}/log`, {
          limit,
        })) as { n?: number; t?: string }[];
        if (!rows.length) return "No log output for this task yet.";
        const body = rows.map((r) => r.t ?? "").join("\n");
        return `## Task log\n\n\`\`\`\n${body}\n\`\`\``;
      }),
  );
}
