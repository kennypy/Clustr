/**
 * Resource pool tools: the Datacenter → Permissions → Pools view. Lets you see
 * pools and their members (relevant to the pool-scoped token model Clustr's docs
 * recommend).
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

export function register(server: McpServer): void {
  server.registerTool(
    "list_pools",
    {
      title: "List Resource Pools",
      description: "List Proxmox resource pools (id and comment).",
      annotations: READ,
    },
    async () =>
      safe("list_pools", async () => {
        const pools = (await proxmoxGet("/pools")) as Record<string, any>[];
        if (!pools.length) return "No resource pools configured.";
        const lines = [`## Resource pools (${pools.length})\n`];
        for (const p of pools) {
          lines.push(`- **${p.poolid}**${p.comment ? ` - ${p.comment}` : ""}`);
        }
        lines.push("\nUse `get_pool` to see a pool's members.");
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "get_pool",
    {
      title: "Get Pool Members",
      description:
        "List the members (VMs, containers, storage) of a resource pool.",
      inputSchema: { poolid: z.string().describe("Pool ID") },
      annotations: READ,
    },
    async ({ poolid }) =>
      safe("get_pool", async () => {
        const data = (await proxmoxGet(`/pools/${poolid}`)) as Record<string, any>;
        const members = (data.members ?? []) as Record<string, any>[];
        if (!members.length) return `Pool '${poolid}' has no members.`;
        const lines = [`## Pool: ${poolid} (${members.length} members)\n`];
        for (const m of members) {
          if (m.type === "storage") {
            lines.push(`- 💾 storage ${m.storage ?? m.id} (${m.node})`);
          } else {
            const icon = m.status === "running" ? "🟢" : "⚫";
            lines.push(
              `- ${icon} ${m.type === "qemu" ? "VM" : "CT"} ${m.vmid} ${m.name ?? ""} (${m.node}) - ${m.status ?? "?"}`,
            );
          }
        }
        return lines.join("\n");
      }),
  );
}
