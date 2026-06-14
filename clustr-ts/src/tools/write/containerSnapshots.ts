/**
 * Write tools for LXC container snapshots. LXC snapshots have no RAM state.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxmoxDelete, proxmoxPost } from "../../proxmox.js";
import { needsConfirm, safe } from "../../safe.js";

const SAFE_WRITE = { readOnlyHint: false, destructiveHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;
const SNAP_NAME = /^[a-zA-Z0-9_-]{1,40}$/;

const node = z.string().describe("Node name");
const ctid = z.number().int().min(100).describe("Container ID");
const confirm = z
  .boolean()
  .default(false)
  .describe(
    "Must be true to execute this destructive operation. When false (default), " +
      "returns a confirmation prompt without acting.",
  );

export function register(server: McpServer): void {
  server.registerTool(
    "create_container_snapshot",
    {
      title: "Create Container Snapshot",
      description:
        "Create a snapshot of an LXC container. Names: alphanumeric/hyphens/" +
        "underscores, max 40 chars.",
      inputSchema: {
        node,
        ctid,
        snapname: z.string().describe("Snapshot name (alphanumeric, -, _; max 40)"),
        description: z.string().optional().describe("Optional description"),
      },
      annotations: SAFE_WRITE,
    },
    async ({ node: n, ctid: id, snapname, description }) =>
      safe("create_container_snapshot", async () => {
        if (!SNAP_NAME.test(snapname)) {
          return "Error: Snapshot name must be alphanumeric with hyphens/underscores only, max 40 characters.";
        }
        const body: Record<string, string> = { snapname };
        if (description) body.description = description;
        const task = await proxmoxPost(`/nodes/${n}/lxc/${id}/snapshot`, body);
        return (
          `✅ Snapshot **${snapname}** creation started for container ${id} on ${n}.\n` +
          `Task ID: \`${String(task)}\`\n\nUse \`list_container_snapshots\` to confirm.`
        );
      }),
  );

  server.registerTool(
    "delete_container_snapshot",
    {
      title: "Delete Container Snapshot",
      description:
        "Permanently delete a snapshot of an LXC container. Cannot be undone.",
      inputSchema: {
        node,
        ctid,
        snapname: z.string().describe("Exact snapshot name to delete"),
        confirm,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ node: n, ctid: id, snapname, confirm: ok }) =>
      safe("delete_container_snapshot", async () => {
        if (!SNAP_NAME.test(snapname)) {
          return "Error: invalid snapshot name (alphanumeric, hyphens/underscores, max 40).";
        }
        if (!ok) {
          return needsConfirm(
            "delete snapshot",
            `**${snapname}** of container ${id} on ${n}`,
          );
        }
        const task = await proxmoxDelete(
          `/nodes/${n}/lxc/${id}/snapshot/${snapname}`,
        );
        return `✅ Snapshot **${snapname}** deletion started for container ${id} on ${n}.\nTask ID: \`${String(task)}\``;
      }),
  );

  server.registerTool(
    "rollback_container_snapshot",
    {
      title: "Rollback Container to Snapshot",
      description:
        "Roll an LXC container back to a snapshot. WARNING: all changes after " +
        "the snapshot are lost. The container should be stopped first.",
      inputSchema: {
        node,
        ctid,
        snapname: z.string().describe("Snapshot name to roll back to"),
        confirm,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ node: n, ctid: id, snapname, confirm: ok }) =>
      safe("rollback_container_snapshot", async () => {
        if (!SNAP_NAME.test(snapname)) {
          return "Error: invalid snapshot name (alphanumeric, hyphens/underscores, max 40).";
        }
        if (!ok) {
          return needsConfirm(
            "roll back to snapshot",
            `**${snapname}** on container ${id} (${n}) — discarding all later changes`,
          );
        }
        const task = await proxmoxPost(
          `/nodes/${n}/lxc/${id}/snapshot/${snapname}/rollback`,
        );
        return (
          `✅ Rollback to snapshot **${snapname}** started for container ${id} on ${n}.\n` +
          `Task ID: \`${String(task)}\`\n\n⚠️ All changes after this snapshot have been discarded.`
        );
      }),
  );
}
