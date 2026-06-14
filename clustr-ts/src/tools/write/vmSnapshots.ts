/**
 * Write tools for QEMU VM snapshots. create is non-destructive; delete and
 * rollback are destructive (rollback discards changes since the snapshot).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxmoxDelete, proxmoxPost } from "../../proxmox.js";
import { needsConfirm, safe } from "../../safe.js";

const SAFE_WRITE = { readOnlyHint: false, destructiveHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;
const SNAP_NAME = /^[a-zA-Z0-9_-]{1,40}$/;

const node = z.string().describe("Node name");
const vmid = z.number().int().min(100).describe("VM ID");
const confirm = z
  .boolean()
  .default(false)
  .describe(
    "Must be true to execute this destructive operation. When false (default), " +
      "returns a confirmation prompt without acting.",
  );

export function register(server: McpServer): void {
  server.registerTool(
    "create_vm_snapshot",
    {
      title: "Create VM Snapshot",
      description:
        "Create a snapshot of a QEMU VM. Names: alphanumeric/hyphens/underscores, " +
        "max 40 chars. Optionally include RAM state (VM must be running).",
      inputSchema: {
        node,
        vmid,
        snapname: z.string().describe("Snapshot name (alphanumeric, -, _; max 40)"),
        description: z.string().optional().describe("Optional description"),
        include_ram: z
          .boolean()
          .default(false)
          .describe("Include RAM state (VM must be running). Default false."),
      },
      annotations: SAFE_WRITE,
    },
    async ({ node: n, vmid: id, snapname, description, include_ram }) =>
      safe("create_vm_snapshot", async () => {
        if (!SNAP_NAME.test(snapname)) {
          return "Error: Snapshot name must be alphanumeric with hyphens/underscores only, max 40 characters.";
        }
        const body: Record<string, string | number> = { snapname };
        if (description) body.description = description;
        if (include_ram) body.vmstate = 1;
        const task = await proxmoxPost(`/nodes/${n}/qemu/${id}/snapshot`, body);
        return (
          `✅ Snapshot **${snapname}** creation started for VM ${id} on ${n}.\n` +
          `Task ID: \`${String(task)}\`\n\nUse \`list_vm_snapshots\` to confirm.`
        );
      }),
  );

  server.registerTool(
    "delete_vm_snapshot",
    {
      title: "Delete VM Snapshot",
      description: "Permanently delete a snapshot of a QEMU VM. Cannot be undone.",
      inputSchema: {
        node,
        vmid,
        snapname: z.string().describe("Exact snapshot name to delete"),
        confirm,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ node: n, vmid: id, snapname, confirm: ok }) =>
      safe("delete_vm_snapshot", async () => {
        if (!SNAP_NAME.test(snapname)) {
          return "Error: invalid snapshot name (alphanumeric, hyphens/underscores, max 40).";
        }
        if (!ok) {
          return needsConfirm(
            "delete snapshot",
            `**${snapname}** of VM ${id} on ${n}`,
          );
        }
        const task = await proxmoxDelete(
          `/nodes/${n}/qemu/${id}/snapshot/${snapname}`,
        );
        return `✅ Snapshot **${snapname}** deletion started for VM ${id} on ${n}.\nTask ID: \`${String(task)}\``;
      }),
  );

  server.registerTool(
    "rollback_vm_snapshot",
    {
      title: "Rollback VM to Snapshot",
      description:
        "Roll a QEMU VM back to a snapshot. WARNING: all changes made after the " +
        "snapshot are lost. The VM should be stopped first.",
      inputSchema: {
        node,
        vmid,
        snapname: z.string().describe("Snapshot name to roll back to"),
        confirm,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ node: n, vmid: id, snapname, confirm: ok }) =>
      safe("rollback_vm_snapshot", async () => {
        if (!SNAP_NAME.test(snapname)) {
          return "Error: invalid snapshot name (alphanumeric, hyphens/underscores, max 40).";
        }
        if (!ok) {
          return needsConfirm(
            "roll back to snapshot",
            `**${snapname}** on VM ${id} (${n}) — discarding all later changes`,
          );
        }
        const task = await proxmoxPost(
          `/nodes/${n}/qemu/${id}/snapshot/${snapname}/rollback`,
        );
        return (
          `✅ Rollback to snapshot **${snapname}** started for VM ${id} on ${n}.\n` +
          `Task ID: \`${String(task)}\`\n\n⚠️ All changes after this snapshot have been discarded.`
        );
      }),
  );
}
