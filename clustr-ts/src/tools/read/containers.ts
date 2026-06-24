/**
 * Read-only tools for LXC container information.
 * All tools: readOnlyHint = true, destructiveHint = false.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxmoxGet } from "../../proxmox.js";
import { hours, mb, pct, safe } from "../../safe.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

const ctid = (c: Record<string, any>): number => Number(c.vmid ?? c.ctid ?? 0);

export function register(server: McpServer): void {
  server.registerTool(
    "list_containers",
    {
      title: "List Containers",
      description:
        "List all LXC containers across all nodes (ID, name, status, CPU, " +
        "memory). Optionally filter by node name.",
      inputSchema: {
        node: z
          .string()
          .optional()
          .describe("Filter to a specific node (optional)."),
      },
      annotations: READ,
    },
    async ({ node }) =>
      safe("list_containers", async () => {
        const filter = node?.trim();
        let rows: Record<string, any>[];
        if (filter) {
          rows = (await proxmoxGet(`/nodes/${filter}/lxc`)) as Record<
            string,
            any
          >[];
          rows.forEach((r) => (r.node = filter));
        } else {
          const res = (await proxmoxGet("/cluster/resources", {
            type: "vm",
          })) as Record<string, any>[];
          rows = res.filter((r) => r.type === "lxc");
        }
        if (!rows?.length) return "No LXC containers found.";
        rows.sort((a, b) => ctid(a) - ctid(b));
        const lines = [`## LXC Containers (${rows.length} total)\n`];
        for (const ct of rows) {
          const icon = ct.status === "running" ? "🟢" : "⚫";
          lines.push(
            `${icon} **${ctid(ct)} - ${ct.name ?? "unnamed"}** ` +
              `(${ct.node ?? filter ?? "unknown"}) - ${ct.status}\n` +
              `   CPU: ${pct(ct.cpu ?? 0)}%  ` +
              `RAM: ${mb(ct.mem ?? 0)} / ${mb(ct.maxmem ?? 0)} MB  ` +
              `Uptime: ${hours(ct.uptime ?? 0)}h`,
          );
        }
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "get_container",
    {
      title: "Get Container Details",
      description:
        "Get the full configuration for a specific LXC container: CPU, memory, " +
        "OS type, storage, network, and startup settings.",
      inputSchema: {
        node: z.string().describe("Node name where the container resides"),
        ctid: z.number().int().min(100).describe("Container ID number"),
      },
      annotations: READ,
    },
    async ({ node, ctid: id }) =>
      safe("get_container", async () => {
        const c = (await proxmoxGet(`/nodes/${node}/lxc/${id}/config`)) as Record<
          string,
          any
        >;
        const nets = Object.entries(c)
          .filter(([k]) => /^net\d+$/.test(k))
          .map(([k, v]) => `  - ${k}: ${v}`);
        const mounts = Object.entries(c)
          .filter(([k]) => /^mp\d+$/.test(k))
          .map(([k, v]) => `  - ${k}: ${v}`);
        return [
          `## Container ${id}: ${c.hostname ?? "unnamed"}\n`,
          `**Node:** ${node}`,
          `**OS Type:** ${c.ostype ?? "unknown"}`,
          `**CPU:** ${c.cores ?? 1} core(s)`,
          `**Memory:** ${c.memory ?? 0} MB`,
          `**Swap:** ${c.swap ?? 0} MB`,
          `**Root FS:** ${c.rootfs ?? ""}`,
          `**Unprivileged:** ${c.unprivileged ? "yes" : "no"}`,
          `**Start on Boot:** ${c.onboot ? "yes" : "no"}`,
          `**Tags:** ${c.tags || "none"}`,
          `**Networks:**\n${nets.join("\n") || "  none"}`,
          `**Mounts:**\n${mounts.join("\n") || "  none"}`,
          `**Description:** ${c.description || "none"}`,
        ].join("\n");
      }),
  );

  server.registerTool(
    "get_container_status",
    {
      title: "Get Container Status",
      description:
        "Get current runtime status for an LXC container: power state, CPU, " +
        "memory, disk I/O, and network I/O.",
      inputSchema: {
        node: z.string().describe("Node name where the container resides"),
        ctid: z.number().int().min(100).describe("Container ID number"),
      },
      annotations: READ,
    },
    async ({ node, ctid: id }) =>
      safe("get_container_status", async () => {
        const s = (await proxmoxGet(
          `/nodes/${node}/lxc/${id}/status/current`,
        )) as Record<string, any>;
        const icon = s.status === "running" ? "🟢" : "⚫";
        return [
          `## Container ${id} Status: ${s.name ?? "unnamed"}\n`,
          `${icon} **State:** ${s.status}`,
          `**CPU:** ${pct(s.cpu ?? 0)}%`,
          `**Memory:** ${mb(s.mem ?? 0, 1)} / ${mb(s.maxmem ?? 0, 1)} MB`,
          `**Disk I/O:** ↑ ${mb(s.diskwrite ?? 0, 2)} MB written, ↓ ${mb(s.diskread ?? 0, 2)} MB read`,
          `**Network:** ↑ ${mb(s.netout ?? 0, 2)} MB out, ↓ ${mb(s.netin ?? 0, 2)} MB in`,
          `**Uptime:** ${hours(s.uptime ?? 0)} hours`,
        ].join("\n");
      }),
  );

  server.registerTool(
    "list_container_snapshots",
    {
      title: "List Container Snapshots",
      description:
        "List all snapshots for a specific LXC container (name, time, description).",
      inputSchema: {
        node: z.string().describe("Node name where the container resides"),
        ctid: z.number().int().min(100).describe("Container ID number"),
      },
      annotations: READ,
    },
    async ({ node, ctid: id }) =>
      safe("list_container_snapshots", async () => {
        const snaps = (
          (await proxmoxGet(`/nodes/${node}/lxc/${id}/snapshot`)) as Record<
            string,
            any
          >[]
        ).filter((s) => s.name !== "current");
        if (!snaps.length) return `No snapshots found for container ${id}.`;
        const lines = [`## Snapshots for Container ${id}\n`];
        for (const s of snaps) {
          lines.push(
            `📸 **${s.name}**` + (s.description ? ` - ${s.description}` : ""),
          );
        }
        return lines.join("\n");
      }),
  );
}
