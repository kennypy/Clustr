/**
 * Networking reads: node interfaces (the System → Network view) and guest IP
 * addresses (VMs via the guest agent, containers via their running interfaces).
 * "What's VM 100's IP?" is a constant question Clustr previously couldn't answer.
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
    "list_networks",
    {
      title: "List Node Network Interfaces",
      description:
        "List a node's network interfaces (bridges, bonds, VLANs, physical NICs) " +
        "with addresses and active state (the System → Network view).",
      inputSchema: { node: z.string().describe("Node name (e.g. 'pve')") },
      annotations: READ,
    },
    async ({ node }) =>
      safe("list_networks", async () => {
        const ifaces = (await proxmoxGet(`/nodes/${node}/network`)) as Record<
          string,
          any
        >[];
        if (!ifaces.length) return `No interfaces found on ${node}.`;
        const lines = [`## Network on ${node}\n`];
        for (const i of ifaces.sort((a, b) => String(a.iface).localeCompare(String(b.iface)))) {
          const addr = i.cidr || i.address || "—";
          const ports = i.bridge_ports || i.slaves || "";
          lines.push(
            `- **${i.iface}** (${i.type}) - ${addr}${i.active ? "" : " - inactive"}` +
              (ports ? ` - ports: ${ports}` : ""),
          );
        }
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "get_guest_ips",
    {
      title: "Get Guest IP Addresses",
      description:
        "Get a guest's IP addresses. For a VM this uses the guest agent " +
        "(qemu-guest-agent must be running); for a container it reads the " +
        "running interfaces. Answers 'what's the IP of VM/CT X'.",
      inputSchema: {
        node: z.string().describe("Node name"),
        kind: z.enum(["vm", "container"]).describe("Guest type"),
        vmid: z.number().int().min(100).describe("VM or container ID"),
      },
      annotations: READ,
    },
    async ({ node, kind, vmid }) =>
      safe("get_guest_ips", async () => {
        if (kind === "vm") {
          let data: Record<string, any>;
          try {
            data = (await proxmoxGet(
              `/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`,
            )) as Record<string, any>;
          } catch {
            return `No IPs available for VM ${vmid}. The QEMU guest agent isn't responding (it must be installed and running in the guest).`;
          }
          const ifaces = (data.result ?? []) as Record<string, any>[];
          const lines = [`## VM ${vmid} addresses\n`];
          for (const i of ifaces) {
            const addrs = ((i["ip-addresses"] ?? []) as Record<string, any>[])
              .map((a) => a["ip-address"])
              .filter((a) => a && a !== "127.0.0.1" && a !== "::1");
            if (addrs.length) lines.push(`- ${i.name}: ${addrs.join(", ")}`);
          }
          return lines.length > 1 ? lines.join("\n") : `No non-loopback IPs reported for VM ${vmid}.`;
        }
        const ifaces = (await proxmoxGet(
          `/nodes/${node}/lxc/${vmid}/interfaces`,
        )) as Record<string, any>[];
        const lines = [`## Container ${vmid} addresses\n`];
        for (const i of ifaces) {
          const parts = [i.inet, i.inet6].filter(Boolean);
          if (parts.length) lines.push(`- ${i.name}: ${parts.join(", ")}`);
        }
        return lines.length > 1 ? lines.join("\n") : `No IPs reported for container ${vmid}.`;
      }),
  );
}
