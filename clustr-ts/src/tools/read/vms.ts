/**
 * Read-only tools for QEMU virtual machine information.
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

/**
 * Interpret the qemu `agent` config value. Proxmox returns it as a string
 * ("1" / "0" / "enabled=1,fstrim_cloned_disks=1"), so a plain truthiness check
 * is wrong. Treat it as enabled only when the leading flag is 1.
 */
export function agentEnabled(agent: unknown): boolean {
  const value = String(agent ?? "")
    .trim()
    .toLowerCase();
  if (!value) return false;
  let first = value.split(",")[0];
  if (first.startsWith("enabled=")) first = first.slice("enabled=".length);
  return first === "1";
}

function vmid(v: Record<string, any>): number {
  if (v.vmid != null) return Number(v.vmid);
  if (typeof v.id === "string") return Number(v.id.split("/").pop());
  return 0;
}

export function register(server: McpServer): void {
  server.registerTool(
    "list_vms",
    {
      title: "List Virtual Machines",
      description:
        "List all QEMU virtual machines across all nodes (VM ID, name, status, " +
        "CPU, memory). Optionally filter by node name.",
      inputSchema: {
        node: z
          .string()
          .optional()
          .describe("Filter to a specific node (optional)."),
      },
      annotations: READ,
    },
    async ({ node }) =>
      safe("list_vms", async () => {
        const filter = node?.trim();
        let rows: Record<string, any>[];
        if (filter) {
          rows = (await proxmoxGet(`/nodes/${filter}/qemu`)) as Record<
            string,
            any
          >[];
          rows.forEach((r) => (r.node = filter));
        } else {
          const res = (await proxmoxGet("/cluster/resources", {
            type: "vm",
          })) as Record<string, any>[];
          rows = res.filter((r) => r.type === "qemu");
        }
        if (!rows?.length) return "No virtual machines found.";
        rows.sort((a, b) => vmid(a) - vmid(b));
        const lines = [`## Virtual Machines (${rows.length} total)\n`];
        for (const vm of rows) {
          const icon = vm.status === "running" ? "🟢" : "⚫";
          lines.push(
            `${icon} **${vmid(vm)} - ${vm.name ?? "unnamed"}** ` +
              `(${vm.node ?? filter ?? "unknown"}) - ${vm.status}\n` +
              `   CPU: ${pct(vm.cpu ?? 0)}%  ` +
              `RAM: ${mb(vm.mem ?? 0)} / ${mb(vm.maxmem ?? 0)} MB  ` +
              `Uptime: ${hours(vm.uptime ?? 0)}h`,
          );
        }
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "get_vm",
    {
      title: "Get VM Details",
      description:
        "Get configuration for a specific QEMU virtual machine by node and VM ID.",
      inputSchema: {
        node: z.string().describe("Node name where the VM resides"),
        vmid: z.number().int().min(100).describe("VM ID number"),
      },
      annotations: READ,
    },
    async ({ node, vmid: id }) =>
      safe("get_vm", async () => {
        const c = (await proxmoxGet(`/nodes/${node}/qemu/${id}/config`)) as Record<
          string,
          any
        >;
        return [
          `## VM ${id}: ${c.name ?? "unnamed"}\n`,
          `**Node:** ${node}`,
          `**CPU:** ${c.cores ?? 1} cores × ${c.sockets ?? 1} socket(s)`,
          `**Memory:** ${c.memory ?? 0} MB`,
          `**OS Type:** ${c.ostype ?? "unknown"}`,
          `**Boot Order:** ${c.boot ?? ""}`,
          `**QEMU Agent:** ${agentEnabled(c.agent) ? "enabled" : "disabled"}`,
          `**Start on Boot:** ${c.onboot ? "yes" : "no"}`,
          `**Tags:** ${c.tags || "none"}`,
          `**Description:** ${c.description || "none"}`,
        ].join("\n");
      }),
  );

  server.registerTool(
    "get_vm_status",
    {
      title: "Get VM Status",
      description:
        "Get current runtime status for a VM: power state, CPU, memory, disk " +
        "I/O, and network I/O.",
      inputSchema: {
        node: z.string().describe("Node name where the VM resides"),
        vmid: z.number().int().min(100).describe("VM ID number"),
      },
      annotations: READ,
    },
    async ({ node, vmid: id }) =>
      safe("get_vm_status", async () => {
        const s = (await proxmoxGet(
          `/nodes/${node}/qemu/${id}/status/current`,
        )) as Record<string, any>;
        const icon = s.status === "running" ? "🟢" : "⚫";
        return [
          `## VM ${id} Status: ${s.name ?? "unnamed"}\n`,
          `${icon} **State:** ${s.status} (${s.qmpstatus ?? "unknown"})`,
          `**CPU:** ${pct(s.cpu ?? 0)}%`,
          `**Memory:** ${mb(s.mem ?? 0, 1)} / ${mb(s.maxmem ?? 0, 1)} MB`,
          `**Disk I/O:** ↑ ${mb(s.diskwrite ?? 0, 2)} MB written, ↓ ${mb(s.diskread ?? 0, 2)} MB read`,
          `**Network:** ↑ ${mb(s.netout ?? 0, 2)} MB out, ↓ ${mb(s.netin ?? 0, 2)} MB in`,
          `**Uptime:** ${hours(s.uptime ?? 0)} hours`,
        ].join("\n");
      }),
  );

  server.registerTool(
    "list_vm_snapshots",
    {
      title: "List VM Snapshots",
      description:
        "List all snapshots for a QEMU virtual machine (name, time, description).",
      inputSchema: {
        node: z.string().describe("Node name where the VM resides"),
        vmid: z.number().int().min(100).describe("VM ID number"),
      },
      annotations: READ,
    },
    async ({ node, vmid: id }) =>
      safe("list_vm_snapshots", async () => {
        const snaps = (
          (await proxmoxGet(`/nodes/${node}/qemu/${id}/snapshot`)) as Record<
            string,
            any
          >[]
        ).filter((s) => s.name !== "current");
        if (!snaps.length) return `No snapshots found for VM ${id}.`;
        const lines = [`## Snapshots for VM ${id}\n`];
        for (const s of snaps) {
          lines.push(
            `📸 **${s.name}**` +
              (s.description ? ` - ${s.description}` : "") +
              (s.vmstate ? " (includes RAM state)" : ""),
          );
        }
        return lines.join("\n");
      }),
  );
}
