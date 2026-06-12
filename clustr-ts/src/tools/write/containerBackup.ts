/**
 * Write tool: create an LXC container backup via vzdump.
 *
 * vzdump is guest-type-agnostic — the same `/nodes/{node}/vzdump` call backs up
 * containers and VMs identically (the API param is `vmid` for both). This tool
 * exists as the container-native counterpart to `create_vm_backup` so the model
 * actually discovers it for CTs instead of reaching for a VM-typed tool.
 *
 * Additive (writes a new archive, changes nothing on the running CT), so no
 * confirm gate. Mode `snapshot` is the default — live, no downtime; `stop`/
 * `suspend` trade availability for consistency. The target storage must support
 * backup content.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxmoxPost } from "../../proxmox.js";
import { safe } from "../../safe.js";

const SAFE_WRITE = { readOnlyHint: false, destructiveHint: false } as const;

const COMPRESS: Record<string, string | number> = {
  zstd: "zstd",
  gzip: "gzip",
  lzo: "lzo",
  none: 0,
};

export function register(server: McpServer): void {
  server.registerTool(
    "create_container_backup",
    {
      title: "Create Container Backup",
      description:
        "Create a backup of an LXC container with vzdump, written to a " +
        "backup-enabled storage. mode=snapshot (default) backs up live with no " +
        "downtime; stop/suspend are more consistent but interrupt the container. " +
        "Returns a task ID; use list_container_backups to see the archive when it " +
        "completes.",
      inputSchema: {
        node: z.string().describe("Node where the container resides (e.g. 'pve')"),
        ctid: z.number().int().min(100).describe("Container ID to back up"),
        storage: z
          .string()
          .describe("Backup-enabled target storage (e.g. 'local', 'pbs')"),
        mode: z
          .enum(["snapshot", "suspend", "stop"])
          .default("snapshot")
          .describe("Backup mode. Default: snapshot (live, no downtime)."),
        compress: z
          .enum(["zstd", "gzip", "lzo", "none"])
          .default("zstd")
          .describe("Compression. Default: zstd."),
        notes: z
          .string()
          .optional()
          .describe("Optional note stored with the backup"),
      },
      annotations: SAFE_WRITE,
    },
    async ({ node, ctid, storage, mode, compress, notes }) =>
      safe("create_container_backup", async () => {
        // vzdump takes the guest id as `vmid` for containers too.
        const body: Record<string, string | number> = {
          vmid: ctid,
          storage,
          mode,
          compress: COMPRESS[compress],
        };
        if (notes) body["notes-template"] = notes;

        const task = await proxmoxPost(`/nodes/${node}/vzdump`, body);
        return (
          `✅ Backup of container ${ctid} started on **${node}** → storage **${storage}** ` +
          `(mode: ${mode}, compress: ${compress}).\n` +
          `Task ID: \`${String(task)}\`\n\n` +
          "Backups can take a while. Use `list_container_backups` to confirm the archive when done."
        );
      }),
  );
}
