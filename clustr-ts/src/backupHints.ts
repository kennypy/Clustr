/**
 * "Back it up first" awareness for destructive guest operations.
 *
 * Before a delete is confirmed, this surfaces the backup-capable storages on the
 * node (and specifically calls out a Proxmox Backup Server if one is attached)
 * so the model (and user) realise there's a safe option and can choose to back up
 * or clone instead of just destroying. It runs inside the tool's host context, so
 * it routes to the right endpoint automatically.
 *
 * It must never block the operation: any failure returns an empty string.
 */

import { proxmoxGet } from "./proxmox.js";

export interface StorageRow {
  storage?: string;
  type?: string;
  content?: string;
  active?: number;
  enabled?: number;
}

/**
 * Pure: turn a node's backup-capable storage list into a recommendation string,
 * or "" if nothing is usable. Separated from the fetch so it can be unit-tested.
 */
export function formatBackupHint(
  rows: StorageRow[],
  guest: "vm" | "container",
): string {
  const usable = rows.filter(
    (r) => r.storage && r.active !== 0 && (r.enabled ?? 1) !== 0,
  );
  if (!usable.length) return "";

  const pbs = usable.filter((r) => r.type === "pbs");
  const names = usable.map((r) => r.storage as string);
  const backupTool = guest === "vm" ? "create_vm_backup" : "create_container_backup";
  const cloneTool = guest === "vm" ? "clone_vm" : "clone_container";
  const target = pbs[0]?.storage ?? names[0];

  const pbsNote = pbs.length
    ? `A **Proxmox Backup Server** is attached (\`${pbs
        .map((p) => p.storage)
        .join("`, `")}\`). Ideal for this. `
    : "";

  return (
    `\n\n💡 **This is irreversible.** ${pbsNote}If it hasn't been backed up, consider first:\n` +
    `- \`${backupTool}\` → \`${target}\` (backup-capable storage: ${names
      .map((n) => `\`${n}\``)
      .join(", ")}), or\n` +
    `- \`${cloneTool}\` to keep a copy.\n` +
    `If the user hasn't said otherwise, ask whether they want a backup or clone before deleting.`
  );
}

/**
 * Fetch the node's backup-capable storages and format the hint. Returns "" on
 * any error: a hint must never get in the way of the actual operation.
 */
export async function backupBeforeDestroyHint(
  node: string,
  guest: "vm" | "container",
): Promise<string> {
  try {
    const rows = (await proxmoxGet(`/nodes/${node}/storage`, {
      content: "backup",
    })) as StorageRow[];
    return formatBackupHint(rows, guest);
  } catch {
    return "";
  }
}
