/**
 * Read-only tools for Proxmox storage information.
 * All tools: readOnlyHint = true, destructiveHint = false.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxmoxGet } from "../../proxmox.js";
import { gb, safe } from "../../safe.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

/**
 * Normalize the two Proxmox endpoints: /cluster/resources reports
 * maxdisk/disk; /nodes/{node}/storage reports total/used/avail. Read whichever
 * set is present so the node-filtered path doesn't render zeros.
 */
function capacity(p: Record<string, any>): {
  total: number;
  used: number;
  avail: number;
} {
  const total = Number(p.maxdisk ?? p.total ?? 0);
  const used = Number(p.disk ?? p.used ?? 0);
  const avail = p.avail != null ? Number(p.avail) : Math.max(total - used, 0);
  return { total, used, avail };
}

function usageBar(percent: number, width = 10): string {
  const filled = Math.round((percent / 100) * width);
  return "[" + "█".repeat(filled) + "░".repeat(Math.max(width - filled, 0)) + "]";
}

export function register(server: McpServer): void {
  server.registerTool(
    "list_storage",
    {
      title: "List Storage Pools",
      description:
        "List all storage pools (name, type, total/used/available capacity). " +
        "Optionally filter by node name.",
      inputSchema: {
        node: z
          .string()
          .optional()
          .describe("Filter to a specific node (optional)."),
      },
      annotations: READ,
    },
    async ({ node }) =>
      safe("list_storage", async () => {
        const filter = node?.trim();
        let pools: Record<string, any>[];
        if (filter) {
          pools = (await proxmoxGet(`/nodes/${filter}/storage`)) as Record<
            string,
            any
          >[];
          pools.forEach((p) => (p.node = filter));
        } else {
          pools = (await proxmoxGet("/cluster/resources", {
            type: "storage",
          })) as Record<string, any>[];
        }
        if (!pools?.length) return "No storage pools found.";
        const mapped = pools.map((p) => {
          const { total, used, avail } = capacity(p);
          return {
            name: p.storage ?? p.id ?? "unknown",
            node: p.node ?? filter ?? "unknown",
            type: p.type ?? "unknown",
            total: gb(total),
            used: gb(used),
            avail: gb(avail),
            usedPct: total ? Math.round((used / total) * 100 * 10) / 10 : 0,
          };
        });
        mapped.sort((a, b) => a.name.localeCompare(b.name));
        const lines = [`## Storage Pools (${mapped.length} total)\n`];
        for (const p of mapped) {
          lines.push(
            `💾 **${p.name}** (${p.node}) - ${p.type}\n` +
              `   ${usageBar(p.usedPct)} ${p.usedPct}%  ` +
              `${p.used} / ${p.total} GB  (${p.avail} GB free)`,
          );
        }
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "get_storage",
    {
      title: "Get Storage Details",
      description:
        "Get detailed information for a specific storage pool on a node, " +
        "including type and a space breakdown.",
      inputSchema: {
        node: z.string().describe("Node name (e.g. 'pve')"),
        storage: z.string().describe("Storage name (e.g. 'local-lvm')"),
      },
      annotations: READ,
    },
    async ({ node, storage }) =>
      safe("get_storage", async () => {
        const info = (await proxmoxGet(
          `/nodes/${node}/storage/${storage}/status`,
        )) as Record<string, any>;
        const { total, used, avail } = capacity(info);
        const usedPct = total ? Math.round((used / total) * 100 * 10) / 10 : 0;
        return [
          `## Storage: ${storage} on ${node}\n`,
          `**Type:** ${info.type ?? "unknown"}`,
          `**Total:** ${gb(total)} GB`,
          `**Used:** ${gb(used)} GB (${usedPct}%)`,
          `**Available:** ${gb(avail)} GB`,
          `**Usage:** ${usageBar(usedPct)}`,
        ].join("\n");
      }),
  );
}
