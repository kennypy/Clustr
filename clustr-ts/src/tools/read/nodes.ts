/**
 * Read-only tools for Proxmox node information.
 * All tools: readOnlyHint = true, destructiveHint = false.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxmoxGet } from "../../proxmox.js";
import { gb, hours, pct, safe } from "../../safe.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

interface NodeRow {
  node?: string;
  status?: string;
  cpu?: number;
  mem?: number;
  maxmem?: number;
  uptime?: number;
}

export function register(server: McpServer): void {
  server.registerTool(
    "list_nodes",
    {
      title: "List Nodes",
      description:
        "List all nodes in the Proxmox cluster with their status, CPU, " +
        "memory usage, and uptime. Use this for an overview of cluster health.",
      annotations: READ,
    },
    async () =>
      safe("list_nodes", async () => {
        const nodes = (await proxmoxGet("/nodes")) as NodeRow[];
        if (!nodes?.length) return "No nodes found in cluster.";
        const lines = ["## Cluster Nodes\n"];
        for (const n of nodes) {
          const icon = n.status === "online" ? "🟢" : "🔴";
          lines.push(
            `${icon} **${n.node}** - ${n.status}\n` +
              `   CPU: ${pct(n.cpu ?? 0)}%  ` +
              `RAM: ${gb(n.mem ?? 0)} / ${gb(n.maxmem ?? 0)} GB  ` +
              `Uptime: ${hours(n.uptime ?? 0)}h`,
          );
        }
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "get_node",
    {
      title: "Get Node Details",
      description:
        "Get detailed status for a specific Proxmox node: CPU usage and model, " +
        "memory, root-disk usage, uptime, kernel version, and PVE version. " +
        "Use get_node_services for the service list.",
      inputSchema: { node: z.string().describe("Node name (e.g. 'pve')") },
      annotations: READ,
    },
    async ({ node }) =>
      safe("get_node", async () => {
        const s = (await proxmoxGet(`/nodes/${node}/status`)) as Record<
          string,
          any
        >;
        return [
          `## Node: ${node}\n`,
          `**CPU:** ${pct(s.cpu ?? 0)}% used | ${s.cpuinfo?.cores ?? "?"} cores | ${s.cpuinfo?.model ?? "?"}`,
          `**Memory:** ${gb(s.memory?.used ?? 0)} / ${gb(s.memory?.total ?? 0)} GB`,
          `**Disk (root):** ${gb(s.rootfs?.used ?? 0)} / ${gb(s.rootfs?.total ?? 0)} GB`,
          `**Uptime:** ${hours(s.uptime ?? 0)} hours`,
          `**Kernel:** ${s.kversion ?? "unknown"}`,
          `**PVE:** ${s.pveversion ?? "unknown"}`,
        ].join("\n");
      }),
  );

  server.registerTool(
    "get_node_services",
    {
      title: "Get Node Services",
      description:
        "List all system services on a Proxmox node with their running state.",
      inputSchema: { node: z.string().describe("Node name (e.g. 'pve')") },
      annotations: READ,
    },
    async ({ node }) =>
      safe("get_node_services", async () => {
        const services = (await proxmoxGet(
          `/nodes/${node}/services`,
        )) as Record<string, any>[];
        if (!services?.length) return `No services found on node '${node}'.`;
        const lines = [`## Services on ${node}\n`];
        for (const s of services) {
          const icon = s.state === "running" ? "🟢" : "🔴";
          lines.push(`${icon} **${s.name}** - ${s.state} (${s.desc ?? ""})`);
        }
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "get_cluster_status",
    {
      title: "Get Cluster Status",
      description:
        "Get overall Proxmox cluster health: quorum, node count, and a " +
        "VM/container resource summary across all nodes.",
      annotations: READ,
    },
    async () =>
      safe("get_cluster_status", async () => {
        const cluster = (await proxmoxGet("/cluster/status")) as Record<
          string,
          any
        >[];
        const resources = (await proxmoxGet("/cluster/resources")) as Record<
          string,
          any
        >[];

        const quorum =
          cluster.find((i) => i.type === "cluster") ?? ({} as Record<string, any>);
        const nodesOnline = cluster.filter(
          (i) => i.type === "node" && i.online,
        ).length;
        const nodesTotal = cluster.filter((i) => i.type === "node").length;
        const count = (type: string, running = false) =>
          resources.filter(
            (r) => r.type === type && (!running || r.status === "running"),
          ).length;

        const quorumIcon = quorum.quorate ? "✅" : "❌";
        return [
          `## Cluster: ${quorum.name ?? "unknown"}\n`,
          `**Quorum:** ${quorumIcon}`,
          `**Nodes:** ${nodesOnline} / ${nodesTotal} online`,
          `**VMs:** ${count("qemu", true)} running / ${count("qemu")} total`,
          `**Containers:** ${count("lxc", true)} running / ${count("lxc")} total`,
        ].join("\n");
      }),
  );
}
