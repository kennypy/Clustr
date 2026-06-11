/**
 * Write tool: create a VM backup via vzdump.
 *
 * Additive (it writes a new archive, changes nothing on the running VM), so no
 * confirm gate. Mode `snapshot` is the default — a live backup with no downtime;
 * `stop`/`suspend` trade availability for consistency. The target storage must
 * support backup content.
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
    "create_vm_backup",
    {
      title: "Create VM Backup",
      description:
        "Create a backup of a QEMU VM with vzdump, written to a backup-enabled " +
        "storage. mode=snapshot (default) backs up live with no downtime; " +
        "stop/suspend are more consistent but interrupt the VM. Returns a task " +
        "ID; use list_vm_backups to see the archive when it completes.",
      inputSchema: {
        node: z.string().describe("Node where the VM resides (e.g. 'pve')"),
        vmid: z.number().int().min(100).describe("VM ID to back up"),
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
    async ({ node, vmid, storage, mode, compress, notes }) =>
      safe("create_vm_backup", async () => {
        const body: Record<string, string | number> = {
          vmid,
          storage,
          mode,
          compress: COMPRESS[compress],
        };
        if (notes) body["notes-template"] = notes;

        const task = await proxmoxPost(`/nodes/${node}/vzdump`, body);
        return (
          `✅ Backup of VM ${vmid} started on **${node}** → storage **${storage}** ` +
          `(mode: ${mode}, compress: ${compress}).\n` +
          `Task ID: \`${String(task)}\`\n\n` +
          "Backups can take a while. Use `list_vm_backups` to confirm the archive when done."
        );
      }),
  );
}
