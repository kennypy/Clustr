/**
 * Write tools to reconfigure and grow an LXC container. Config changes are
 * reversible; rootfs/mount resize is grow-only.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ProxmoxError, proxmoxPut } from "../../proxmox.js";
import { safe } from "../../safe.js";

const WRITE = { readOnlyHint: false, destructiveHint: false } as const;

export function register(server: McpServer): void {
  server.registerTool(
    "update_container_config",
    {
      title: "Update Container Config",
      description:
        "Change an LXC container's configuration: CPU cores, memory, swap, " +
        "hostname, start-on-boot, description, or tags. Only the fields you pass " +
        "are changed.",
      inputSchema: {
        node: z.string().describe("Node where the container resides"),
        ctid: z.number().int().min(100).describe("Container ID"),
        cores: z.number().int().min(1).max(128).optional().describe("CPU cores"),
        memory_mb: z.number().int().min(16).optional().describe("Memory in MB"),
        swap_mb: z.number().int().min(0).optional().describe("Swap in MB"),
        hostname: z.string().optional().describe("Container hostname"),
        onboot: z.boolean().optional().describe("Start on Proxmox boot"),
        description: z.string().optional().describe("Description / notes"),
        tags: z.string().optional().describe("Comma/semicolon-separated tags"),
      },
      annotations: WRITE,
    },
    async ({ node, ctid, cores, memory_mb, swap_mb, hostname, onboot, description, tags }) =>
      safe("update_container_config", async () => {
        const body: Record<string, string | number> = {};
        if (cores !== undefined) body.cores = cores;
        if (memory_mb !== undefined) body.memory = memory_mb;
        if (swap_mb !== undefined) body.swap = swap_mb;
        if (hostname !== undefined) body.hostname = hostname;
        if (onboot !== undefined) body.onboot = onboot ? 1 : 0;
        if (description !== undefined) body.description = description;
        if (tags !== undefined) body.tags = tags;
        if (Object.keys(body).length === 0) {
          throw new ProxmoxError("Nothing to change. Provide at least one field.");
        }
        await proxmoxPut(`/nodes/${node}/lxc/${ctid}/config`, body);
        return (
          `✅ Container ${ctid} on ${node} updated: ${Object.keys(body).join(", ")}.\n` +
          "Use `get_container` to confirm."
        );
      }),
  );

  server.registerTool(
    "resize_container_disk",
    {
      title: "Resize Container Disk (Grow)",
      description:
        "Grow an LXC container mount point (usually 'rootfs'). Grow-only: " +
        "Proxmox cannot shrink. Size is an increment like '+5G' or an absolute " +
        "target like '16G'.",
      inputSchema: {
        node: z.string().describe("Node where the container resides"),
        ctid: z.number().int().min(100).describe("Container ID"),
        disk: z
          .string()
          .default("rootfs")
          .describe("Mount point to grow, e.g. 'rootfs', 'mp0'"),
        size: z
          .string()
          .regex(/^\+?\d+[KMGT]$/, "Size like '+5G' or '16G'")
          .describe("New size: increment ('+5G') or absolute target ('16G')"),
      },
      annotations: WRITE,
    },
    async ({ node, ctid, disk, size }) =>
      safe("resize_container_disk", async () => {
        await proxmoxPut(`/nodes/${node}/lxc/${ctid}/resize`, { disk, size });
        return `✅ ${disk} on container ${ctid} (${node}) resized to ${size}.`;
      }),
  );
}
