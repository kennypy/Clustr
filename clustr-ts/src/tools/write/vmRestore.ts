/**
 * Two-step VM restore from a vzdump archive (qmrestore via the qemu create
 * endpoint with `archive` set).
 *
 *   restore_vm_request → verifies the archive exists, figures out whether the
 *                        target VMID is free or would be OVERWRITTEN (which
 *                        requires force and destroys the current VM), mints a
 *                        single-use 5-min token.
 *   restore_vm_confirm → validates token + target VMID, then runs the restore.
 *
 * Same safety shape as delete: confirm is destructive, request is not. An
 * overwrite restore is refused unless force=true, and refused if the target VM
 * is still running.
 */

import { randomBytes } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ProxmoxError, proxmoxGet, proxmoxPost } from "../../proxmox.js";
import { safe } from "../../safe.js";

const TOKEN_TTL_MS = 5 * 60 * 1000;

export interface PendingRestore {
  node: string;
  archive: string;
  vmid: number;
  storage: string;
  force: boolean;
  overwrite: boolean;
  expires: number;
}

export const pendingRestores = new Map<string, PendingRestore>();

const REQUEST = { readOnlyHint: false, destructiveHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;

function purgeExpired(): void {
  const now = Date.now();
  for (const [token, v] of pendingRestores) {
    if (v.expires < now) pendingRestores.delete(token);
  }
}

/** Validate + consume a restore token (pure; unit-testable). */
export function consumeRestoreToken(token: string, vmid: number): PendingRestore {
  purgeExpired();
  const pending = pendingRestores.get(token);
  if (!pending) {
    throw new ProxmoxError(
      "Confirmation token not found or expired. Call restore_vm_request again to get a fresh token.",
    );
  }
  if (pending.vmid !== vmid) {
    throw new ProxmoxError(
      `Target VM ID mismatch. Expected ${pending.vmid}, got ${vmid}. ` +
        "Provide the exact target VM ID returned by restore_vm_request.",
    );
  }
  pendingRestores.delete(token);
  return pending;
}

async function vmExists(node: string, vmid: number): Promise<boolean> {
  try {
    await proxmoxGet(`/nodes/${node}/qemu/${vmid}/config`);
    return true;
  } catch {
    return false;
  }
}

async function requestRestore(
  node: string,
  archive: string,
  vmid: number,
  storage: string,
  force: boolean,
): Promise<{ token: string; overwrite: boolean }> {
  // Verify the archive exists on the storage named in its volid.
  const sep = archive.indexOf(":");
  if (sep < 0) {
    throw new ProxmoxError(
      `Invalid archive '${archive}'. Expected a volume id like ` +
        "'local:backup/vzdump-qemu-100-...'. Use list_vm_backups to get one.",
    );
  }
  const archiveStorage = archive.slice(0, sep);
  const archives = (await proxmoxGet(
    `/nodes/${node}/storage/${archiveStorage}/content`,
    { content: "backup" },
  )) as { volid?: string }[];
  if (!archives.some((a) => a.volid === archive)) {
    throw new ProxmoxError(
      `Backup archive not found on '${archiveStorage}': ${archive}. ` +
        "Use list_vm_backups to list valid archives.",
    );
  }

  // Decide fresh-restore vs overwrite.
  const overwrite = await vmExists(node, vmid);
  if (overwrite) {
    if (!force) {
      throw new ProxmoxError(
        `VM ${vmid} already exists. Restoring onto it will DESTROY the current ` +
          "VM and replace it with the backup. To proceed, call restore_vm_request " +
          "again with force=true.",
      );
    }
    const status = (await proxmoxGet(
      `/nodes/${node}/qemu/${vmid}/status/current`,
    )) as { status?: string };
    if (status.status === "running") {
      throw new ProxmoxError(
        `VM ${vmid} is running. Stop it before restoring over it.`,
      );
    }
  }

  const token = randomBytes(16).toString("hex");
  pendingRestores.set(token, {
    node,
    archive,
    vmid,
    storage,
    force,
    overwrite,
    expires: Date.now() + TOKEN_TTL_MS,
  });
  return { token, overwrite };
}

async function confirmRestore(token: string, vmid: number): Promise<string> {
  const r = consumeRestoreToken(token, vmid);

  // Re-check the overwrite precondition right before acting: the VM could have
  // been started again within the token's lifetime.
  if (r.overwrite) {
    const status = (await proxmoxGet(
      `/nodes/${r.node}/qemu/${r.vmid}/status/current`,
    )) as { status?: string };
    if (status.status === "running") {
      throw new ProxmoxError(
        `VM ${r.vmid} is running again. Stop it and re-request the restore. Nothing was changed.`,
      );
    }
  }

  const body: Record<string, string | number> = {
    vmid: r.vmid,
    archive: r.archive,
  };
  if (r.storage) body.storage = r.storage;
  if (r.overwrite) body.force = 1;

  const task = await proxmoxPost(`/nodes/${r.node}/qemu`, body);
  return String(task);
}

export function register(server: McpServer): void {
  server.registerTool(
    "restore_vm_request",
    {
      title: "Request VM Restore (Step 1 of 2)",
      description:
        "Step 1 of 2: Request a restore of a VM from a backup archive. Pass a " +
        "backup volume id (from list_vm_backups) and the target VM ID. Returns a " +
        "confirmation token. If the target VM ID already exists, the restore " +
        "OVERWRITES it (destroying the current VM) and requires force=true. You " +
        "MUST call restore_vm_confirm with the token and target VM ID.",
      inputSchema: {
        node: z.string().describe("Node to restore on (e.g. 'pve')"),
        archive: z
          .string()
          .describe(
            "Backup volume id from list_vm_backups, e.g. 'local:backup/vzdump-qemu-100-...'",
          ),
        vmid: z
          .number()
          .int()
          .min(100)
          .describe("Target VM ID to restore into"),
        storage: z
          .string()
          .default("")
          .describe(
            "Optional target storage for the restored disks. Empty = use the backup's original storage.",
          ),
        force: z
          .boolean()
          .default(false)
          .describe(
            "Allow overwriting an existing VM at the target ID (destroys it). Required when the ID is in use.",
          ),
      },
      annotations: REQUEST,
    },
    async ({ node, archive, vmid, storage, force }) =>
      safe("restore_vm_request", async () => {
        const { token, overwrite } = await requestRestore(
          node,
          archive,
          vmid,
          storage.trim(),
          force,
        );
        const head = overwrite
          ? `⚠️ **VM Restore Request: Step 1 of 2 (OVERWRITE)**\n\nThis will ` +
            `**destroy existing VM ${vmid}** on **${node}** and replace it with the backup.`
          : `⚠️ **VM Restore Request: Step 1 of 2**\n\nThis will restore the backup ` +
            `into **new VM ${vmid}** on **${node}**.`;
        return (
          `${head}\n\n` +
          `- Archive: \`${archive}\`\n` +
          `- Target VM ID: ${vmid}\n` +
          `- Disk storage: ${storage.trim() || "(from backup)"}\n\n` +
          "To proceed, call `restore_vm_confirm` with:\n" +
          `- \`confirmation_token\`: \`${token}\`\n` +
          `- \`vmid\`: \`${vmid}\`\n\n` +
          "⏰ Token expires in 5 minutes."
        );
      }),
  );

  server.registerTool(
    "restore_vm_confirm",
    {
      title: "Confirm VM Restore (Step 2 of 2)",
      description:
        "Step 2 of 2: Execute a VM restore. Requires the confirmation_token from " +
        "restore_vm_request AND the exact target VM ID. If the target existed, " +
        "this overwrites/destroys it. This cannot be undone.",
      inputSchema: {
        confirmation_token: z.string().describe("Token from restore_vm_request"),
        vmid: z
          .number()
          .int()
          .min(100)
          .describe("Target VM ID, exactly as returned by restore_vm_request"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ confirmation_token, vmid }) =>
      safe("restore_vm_confirm", async () => {
        const task = await confirmRestore(confirmation_token, vmid);
        return (
          `♻️ Restore into VM **${vmid}** started.\nTask ID: \`${task}\`\n\n` +
          "Use `get_vm_status` to check when it is ready, then start it."
        );
      }),
  );
}
