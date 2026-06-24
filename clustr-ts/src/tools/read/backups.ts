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
  subtype?: string;
  notes?: string;
}

/**
 * Is this backup entry a QEMU VM backup (vs. an LXC container backup)?
 *
 * Works across storage types, which encode the type differently:
 *   - file (local/NFS): volid `…/vzdump-qemu-100-…` (VM) vs `…vzdump-lxc-…` (CT)
 *   - PBS: volid `pbs:backup/vm/100/…` (VM) vs `…/ct/…` (CT), plus a `subtype`.
 * Prefer the explicit `subtype` when present; otherwise exclude only entries
 * that clearly look like containers, and include everything else, biasing
 * toward showing a backup rather than silently hiding a real VM archive.
 */
export function isVmBackup(r: BackupRow): boolean {
  if (r.subtype) return r.subtype === "qemu";
  const v = String(r.volid ?? "").toLowerCase();
  if (v.includes("vzdump-lxc-") || v.includes("/ct/") || v.includes("pbs-ct")) {
    return false;
  }
  return true;
}

export function register(server: McpServer): void {
  server.registerTool(
    "list_vm_backups",
    {
      title: "List VM Backups",
      description:
        "List VM backup archives on a storage (volume id, source VM ID, size, " +
        "creation time). Works with both file storages (vzdump) and Proxmox " +
        "Backup Server (PBS). Optionally filter to one VM. Use the volume id " +
        "with restore_vm_request to restore.",
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

        // Keep VM backups, drop container ones, across file storages AND PBS
        // (whose volids look like `pbs:backup/vm/100/…`, not `vzdump-qemu-*`).
        rows = rows.filter(isVmBackup);
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
            `🗄️ **VM ${r.vmid}** - ${gb(r.size ?? 0)} GB - ${when}` +
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

  server.registerTool(
    "list_container_backups",
    {
      title: "List Container Backups",
      description:
        "List LXC container backup archives on a storage (volume id, source " +
        "container ID, size, creation time). Works with both file storages " +
        "(vzdump) and Proxmox Backup Server (PBS). Optionally filter to one " +
        "container.",
      inputSchema: {
        node: z.string().describe("Node that can see the storage (e.g. 'pve')"),
        storage: z
          .string()
          .describe("Backup-enabled storage to enumerate (e.g. 'local')"),
        ctid: z
          .number()
          .int()
          .min(100)
          .optional()
          .describe("Optional: only show backups for this container ID"),
      },
      annotations: READ,
    },
    async ({ node, storage, ctid }) =>
      safe("list_container_backups", async () => {
        let rows = (await proxmoxGet(
          `/nodes/${node}/storage/${storage}/content`,
          { content: "backup" },
        )) as BackupRow[];

        // Container backups are exactly the inverse of the VM filter.
        rows = rows.filter((r) => !isVmBackup(r));
        if (ctid !== undefined) {
          rows = rows.filter((r) => Number(r.vmid) === ctid);
        }
        if (!rows.length) {
          return `No container backups found on '${storage}'${
            ctid !== undefined ? ` for container ${ctid}` : ""
          }.`;
        }

        rows.sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0)); // newest first
        const lines = [`## Container Backups on ${storage} (${rows.length})\n`];
        for (const r of rows) {
          const when = r.ctime
            ? new Date(r.ctime * 1000).toISOString().replace("T", " ").slice(0, 19)
            : "unknown";
          lines.push(
            `🗄️ **CT ${r.vmid}** - ${gb(r.size ?? 0)} GB - ${when}` +
              (r.notes ? `\n   📝 ${r.notes}` : "") +
              `\n   \`${r.volid}\``,
          );
        }
        lines.push(
          "\nThe `volid` is what a container restore consumes as its archive.",
        );
        return lines.join("\n");
      }),
  );
}
