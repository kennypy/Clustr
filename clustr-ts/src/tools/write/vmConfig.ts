/**
 * Write tools to reconfigure and grow a QEMU VM: the management half that was
 * missing between create and delete. Config changes are reversible (set the
 * value back); disk resize is grow-only (Proxmox does not shrink), so it is
 * additive and safe.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ProxmoxError, proxmoxPut } from "../../proxmox.js";
import { safe } from "../../safe.js";

const WRITE = { readOnlyHint: false, destructiveHint: false } as const;

export function register(server: McpServer): void {
  server.registerTool(
    "update_vm_config",
    {
      title: "Update VM Config",
      description:
        "Change a QEMU VM's configuration: CPU cores/sockets, memory, name, " +
        "start-on-boot, description, or tags. Only the fields you pass are " +
        "changed. Some changes (cores/memory) take effect after the next reboot.",
      inputSchema: {
        node: z.string().describe("Node where the VM resides"),
        vmid: z.number().int().min(100).describe("VM ID"),
        cores: z.number().int().min(1).max(128).optional().describe("CPU cores"),
        sockets: z.number().int().min(1).max(4).optional().describe("CPU sockets"),
        memory_mb: z.number().int().min(16).optional().describe("Memory in MB"),
        name: z.string().optional().describe("VM name"),
        onboot: z.boolean().optional().describe("Start on Proxmox boot"),
        description: z.string().optional().describe("Description / notes"),
        tags: z.string().optional().describe("Comma/semicolon-separated tags"),
      },
      annotations: WRITE,
    },
    async ({ node, vmid, cores, sockets, memory_mb, name, onboot, description, tags }) =>
      safe("update_vm_config", async () => {
        const body: Record<string, string | number> = {};
        if (cores !== undefined) body.cores = cores;
        if (sockets !== undefined) body.sockets = sockets;
        if (memory_mb !== undefined) body.memory = memory_mb;
        if (name !== undefined) body.name = name;
        if (onboot !== undefined) body.onboot = onboot ? 1 : 0;
        if (description !== undefined) body.description = description;
        if (tags !== undefined) body.tags = tags;
        if (Object.keys(body).length === 0) {
          throw new ProxmoxError("Nothing to change. Provide at least one field.");
        }
        await proxmoxPut(`/nodes/${node}/qemu/${vmid}/config`, body);
        return (
          `✅ VM ${vmid} on ${node} updated: ${Object.keys(body).join(", ")}.\n` +
          "Use `get_vm` to confirm. CPU/memory changes apply after the next reboot."
        );
      }),
  );

  server.registerTool(
    "resize_vm_disk",
    {
      title: "Resize VM Disk (Grow)",
      description:
        "Grow a QEMU VM disk. Proxmox can only ENLARGE disks, never shrink. Size " +
        "is an increment like '+10G' (add 10 GiB) or an absolute target like " +
        "'64G' (must be larger than current). You'll usually need to grow the " +
        "filesystem inside the guest afterwards.",
      inputSchema: {
        node: z.string().describe("Node where the VM resides"),
        vmid: z.number().int().min(100).describe("VM ID"),
        disk: z
          .string()
          .describe("Disk to grow, e.g. 'scsi0', 'virtio0', 'sata0'"),
        size: z
          .string()
          .regex(/^\+?\d+[KMGT]$/, "Size like '+10G' or '64G'")
          .describe("New size: increment ('+10G') or absolute target ('64G')"),
      },
      annotations: WRITE,
    },
    async ({ node, vmid, disk, size }) =>
      safe("resize_vm_disk", async () => {
        await proxmoxPut(`/nodes/${node}/qemu/${vmid}/resize`, { disk, size });
        return (
          `✅ Disk ${disk} on VM ${vmid} (${node}) resized to ${size}.\n` +
          "Remember to grow the filesystem/partition inside the guest to use the new space."
        );
      }),
  );
}
