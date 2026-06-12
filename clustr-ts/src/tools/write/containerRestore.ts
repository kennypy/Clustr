/**
 * Two-step LXC container restore from a vzdump archive (`pct restore` via the
 * lxc create endpoint with `restore=1` and `ostemplate` set to the backup volid).
 *
 *   restore_container_request → verifies the archive exists, figures out whether
 *                               the target CTID is free or would be OVERWRITTEN
 *                               (which requires force and destroys the current
 *                               container), mints a single-use 5-min token.
 *   restore_container_confirm → validates token + target CTID, then runs it.
 *
 * Same safety shape as vmRestore: confirm is destructive, request is not. An
 * overwrite restore is refused unless force=true, and refused if the target
 * container is still running.
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
  ctid: number;
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
export function consumeRestoreToken(token: string, ctid: number): PendingRestore {
  purgeExpired();
  const pending = pendingRestores.get(token);
  if (!pending) {
    throw new ProxmoxError(
      "Confirmation token not found or expired. Call restore_container_request again to get a fresh token.",
    );
  }
  if (pending.ctid !== ctid) {
    throw new ProxmoxError(
      `Target container ID mismatch. Expected ${pending.ctid}, got ${ctid}. ` +
        "Provide the exact target container ID returned by restore_container_request.",
    );
  }
  pendingRestores.delete(token);
  return pending;
}

async function containerExists(node: string, ctid: number): Promise<boolean> {
  try {
    await proxmoxGet(`/nodes/${node}/lxc/${ctid}/config`);
    return true;
  } catch {
    return false;
  }
}

async function requestRestore(
  node: string,
  archive: string,
  ctid: number,
  storage: string,
  force: boolean,
): Promise<{ token: string; overwrite: boolean }> {
  // Verify the archive exists on the storage named in its volid.
  const sep = archive.indexOf(":");
  if (sep < 0) {
    throw new ProxmoxError(
      `Invalid archive '${archive}'. Expected a volume id like ` +
        "'local:backup/vzdump-lxc-100-...'. Use list_container_backups to get one.",
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
        "Use list_container_backups to list valid archives.",
    );
  }

  // Decide fresh-restore vs overwrite.
  const overwrite = await containerExists(node, ctid);
  if (overwrite) {
    if (!force) {
      throw new ProxmoxError(
        `Container ${ctid} already exists. Restoring onto it will DESTROY the ` +
          "current container and replace it with the backup. To proceed, call " +
          "restore_container_request again with force=true.",
      );
    }
    const status = (await proxmoxGet(
      `/nodes/${node}/lxc/${ctid}/status/current`,
    )) as { status?: string };
    if (status.status === "running") {
      throw new ProxmoxError(
        `Container ${ctid} is running. Stop it before restoring over it.`,
      );
    }
  }

  const token = randomBytes(16).toString("hex");
  pendingRestores.set(token, {
    node,
    archive,
    ctid,
    storage,
    force,
    overwrite,
    expires: Date.now() + TOKEN_TTL_MS,
  });
  return { token, overwrite };
}

async function confirmRestore(token: string, ctid: number): Promise<string> {
  const r = consumeRestoreToken(token, ctid);

  // Re-check the overwrite precondition right before acting: the container could
  // have been started again within the token's lifetime.
  if (r.overwrite) {
    const status = (await proxmoxGet(
      `/nodes/${r.node}/lxc/${r.ctid}/status/current`,
    )) as { status?: string };
    if (status.status === "running") {
      throw new ProxmoxError(
        `Container ${r.ctid} is running again. Stop it and re-request the restore. Nothing was changed.`,
      );
    }
  }

  // pct restore = the lxc create endpoint with restore=1 and the archive as
  // `ostemplate`.
  const body: Record<string, string | number> = {
    vmid: r.ctid,
    ostemplate: r.archive,
    restore: 1,
  };
  if (r.storage) body.storage = r.storage;
  if (r.overwrite) body.force = 1;

  const task = await proxmoxPost(`/nodes/${r.node}/lxc`, body);
  return String(task);
}

export function register(server: McpServer): void {
  server.registerTool(
    "restore_container_request",
    {
      title: "Request Container Restore (Step 1 of 2)",
      description:
        "Step 1 of 2: Request a restore of an LXC container from a backup " +
        "archive. Pass a backup volume id (from list_container_backups) and the " +
        "target container ID. Returns a confirmation token. If the target ID " +
        "already exists, the restore OVERWRITES it (destroying the current " +
        "container) and requires force=true. You MUST call " +
        "restore_container_confirm with the token and target container ID.",
      inputSchema: {
        node: z.string().describe("Node to restore on (e.g. 'pve')"),
        archive: z
          .string()
          .describe(
            "Backup volume id from list_container_backups, e.g. 'local:backup/vzdump-lxc-100-...'",
          ),
        ctid: z
          .number()
          .int()
          .min(100)
          .describe("Target container ID to restore into"),
        storage: z
          .string()
          .default("")
          .describe(
            "Optional target storage for the restored rootfs. Empty = use the backup's original storage.",
          ),
        force: z
          .boolean()
          .default(false)
          .describe(
            "Allow overwriting an existing container at the target ID (destroys it). Required when the ID is in use.",
          ),
      },
      annotations: REQUEST,
    },
    async ({ node, archive, ctid, storage, force }) =>
      safe("restore_container_request", async () => {
        const { token, overwrite } = await requestRestore(
          node,
          archive,
          ctid,
          storage.trim(),
          force,
        );
        const head = overwrite
          ? `⚠️ **Container Restore Request — Step 1 of 2 (OVERWRITE)**\n\nThis will ` +
            `**destroy existing container ${ctid}** on **${node}** and replace it with the backup.`
          : `⚠️ **Container Restore Request — Step 1 of 2**\n\nThis will restore the backup ` +
            `into **new container ${ctid}** on **${node}**.`;
        return (
          `${head}\n\n` +
          `- Archive: \`${archive}\`\n` +
          `- Target container ID: ${ctid}\n` +
          `- Rootfs storage: ${storage.trim() || "(from backup)"}\n\n` +
          "To proceed, call `restore_container_confirm` with:\n" +
          `- \`confirmation_token\`: \`${token}\`\n` +
          `- \`ctid\`: \`${ctid}\`\n\n` +
          "⏰ Token expires in 5 minutes."
        );
      }),
  );

  server.registerTool(
    "restore_container_confirm",
    {
      title: "Confirm Container Restore (Step 2 of 2)",
      description:
        "Step 2 of 2: Execute a container restore. Requires the " +
        "confirmation_token from restore_container_request AND the exact target " +
        "container ID. If the target existed, this overwrites/destroys it. This " +
        "cannot be undone.",
      inputSchema: {
        confirmation_token: z
          .string()
          .describe("Token from restore_container_request"),
        ctid: z
          .number()
          .int()
          .min(100)
          .describe("Target container ID, exactly as returned by restore_container_request"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ confirmation_token, ctid }) =>
      safe("restore_container_confirm", async () => {
        const task = await confirmRestore(confirmation_token, ctid);
        return (
          `♻️ Restore into container **${ctid}** started.\nTask ID: \`${task}\`\n\n` +
          "Use `get_container_status` to check when it is ready, then start it."
        );
      }),
  );
}
