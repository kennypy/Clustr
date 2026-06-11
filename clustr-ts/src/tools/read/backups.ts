/**
 * Read-only tool: enumerate VM backup archives on a storage so a restore has
 * something concrete to point at.
 *
 * Proxmox keeps backups as storage "content" of type `backup`; each has a
 * `volid` (e.g. `local:backup/vzdump-qemu-100-2026_06_11-00_00_00.vma.zst`)
 * which is exactly what restore_vm_request consumes.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxmoxGet } from "../../proxmox.js";
import { gb, safe } from "../../safe.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

interface BackupRow {
  volid?: string;
  vmid?: number | string;
  size?: number;
  ctime?: number;
  format?: string;
  notes?: string;
}

export function register(server: McpServer): void {
  server.registerTool(
    "list_vm_backups",
    {
      title: "List VM Backups",
      description:
        "List VM backup archives on a storage (volume id, source VM ID, size, " +
        "creation time). Optionally filter to one VM. Use the volume id with " +
        "restore_vm_request to restore.",
      inputSchema: {
        node: z.string().describe("Node that can see the storage (e.g. 'pve')"),
        storage: z
          .string()
          .describe("Backup-enabled storage to enumerate (e.g. 'local')"),
        vmid: z
          .number()
          .int()
          .min(100)
          .optional()
          .describe("Optional: only show backups for this VM ID"),
      },
      annotations: READ,
    },
    async ({ node, storage, vmid }) =>
      safe("list_vm_backups", async () => {
        let rows = (await proxmoxGet(
          `/nodes/${node}/storage/${storage}/content`,
          { content: "backup" },
        )) as BackupRow[];

        // VM backups are vzdump-qemu-*; drop container (lxc) archives.
        rows = rows.filter((r) => String(r.volid ?? "").includes("qemu"));
        if (vmid !== undefined) {
          rows = rows.filter((r) => Number(r.vmid) === vmid);
        }
        if (!rows.length) {
          return `No VM backups found on '${storage}'${
            vmid !== undefined ? ` for VM ${vmid}` : ""
          }.`;
        }

        rows.sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0)); // newest first
        const lines = [`## VM Backups on ${storage} (${rows.length})\n`];
        for (const r of rows) {
          const when = r.ctime
            ? new Date(r.ctime * 1000).toISOString().replace("T", " ").slice(0, 19)
            : "unknown";
          lines.push(
            `🗄️ **VM ${r.vmid}** — ${gb(r.size ?? 0)} GB — ${when}` +
              (r.notes ? `\n   📝 ${r.notes}` : "") +
              `\n   \`${r.volid}\``,
          );
        }
        lines.push(
          "\nTo restore one, pass its `volid` to `restore_vm_request` as `archive`.",
        );
        return lines.join("\n");
      }),
  );
}
