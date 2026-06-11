/**
 * Two-step QEMU VM deletion.
 *
 *   vm_delete_request → looks the VM up, checks it is stopped, mints a
 *                       single-use token (5-min TTL), returns token + name.
 *   vm_delete_confirm → validates token + exact name, re-verifies the target
 *                       still has that name (guards against VMID reuse), then
 *                       deletes with purge + destroy-unreferenced-disks.
 *
 * The store is in-process memory and clears on restart. JavaScript is
 * single-threaded, so the validate-and-consume below is atomic without a lock.
 */

import { randomBytes } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ProxmoxError, proxmoxDelete, proxmoxGet } from "../../proxmox.js";
import { safe } from "../../safe.js";

const TOKEN_TTL_MS = 5 * 60 * 1000;

export interface PendingDelete {
  node: string;
  vmid: number;
  name: string;
  expires: number;
}

// Exported for tests; not part of the tool surface.
export const pendingDeletes = new Map<string, PendingDelete>();

const REQUEST = { readOnlyHint: false, destructiveHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;

function purgeExpired(): void {
  const now = Date.now();
  for (const [token, v] of pendingDeletes) {
    if (v.expires < now) pendingDeletes.delete(token);
  }
}

/**
 * Validate a confirmation token against the supplied name and consume it.
 * Pure (no Proxmox call) so the token logic is unit-testable. Throws on a
 * missing/expired token or a name mismatch.
 */
export function consumeDeleteToken(token: string, vmName: string): PendingDelete {
  purgeExpired();
  const pending = pendingDeletes.get(token);
  if (!pending) {
    throw new ProxmoxError(
      "Confirmation token not found or expired. Call vm_delete_request again to get a fresh token.",
    );
  }
  if (pending.name !== vmName) {
    throw new ProxmoxError(
      `VM name mismatch. Expected '${pending.name}', got '${vmName}'. ` +
        "Provide the exact VM name returned by vm_delete_request.",
    );
  }
  pendingDeletes.delete(token); // single use
  return pending;
}

async function requestVmDelete(
  node: string,
  vmid: number,
): Promise<{ token: string; name: string }> {
  let config: Record<string, any>;
  try {
    config = (await proxmoxGet(`/nodes/${node}/qemu/${vmid}/config`)) as Record<
      string,
      any
    >;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProxmoxError(`VM ${vmid} not found on node '${node}': ${msg}`);
  }
  const name = config.name ?? `vm-${vmid}`;

  const status = (await proxmoxGet(
    `/nodes/${node}/qemu/${vmid}/status/current`,
  )) as Record<string, any>;
  if (status.status === "running") {
    throw new ProxmoxError(
      `VM ${vmid} (${name}) is currently running. Stop it before requesting deletion.`,
    );
  }

  const token = randomBytes(16).toString("hex");
  pendingDeletes.set(token, {
    node,
    vmid,
    name,
    expires: Date.now() + TOKEN_TTL_MS,
  });
  return { token, name };
}

async function confirmVmDelete(token: string, vmName: string): Promise<string> {
  const { node, vmid, name } = consumeDeleteToken(token, vmName);

  // Re-verify right before deleting: within the token's lifetime the VM could
  // have been removed and the VMID reused. A failed re-check destroys nothing.
  let config: Record<string, any>;
  try {
    config = (await proxmoxGet(`/nodes/${node}/qemu/${vmid}/config`)) as Record<
      string,
      any
    >;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProxmoxError(
      `Could not verify VM ${vmid} on node '${node}' before deletion (it may no ` +
        `longer exist); nothing was deleted: ${msg}`,
    );
  }
  const currentName = config.name ?? `vm-${vmid}`;
  if (currentName !== name) {
    throw new ProxmoxError(
      `VM ${vmid} is now named '${currentName}', not '${name}' — the VMID may ` +
        "have been reused since the delete request. Nothing was deleted. Call " +
        "vm_delete_request again.",
    );
  }

  const task = await proxmoxDelete(`/nodes/${node}/qemu/${vmid}`, {
    purge: 1,
    "destroy-unreferenced-disks": 1,
  });
  return String(task);
}

export function register(server: McpServer): void {
  server.registerTool(
    "vm_delete_request",
    {
      title: "Request VM Deletion (Step 1 of 2)",
      description:
        "Step 1 of 2: Request deletion of a QEMU VM. Returns a confirmation " +
        "token and the VM name. You MUST call vm_delete_confirm with the token " +
        "and exact name. Token expires in 5 minutes. The VM must be stopped.",
      inputSchema: {
        node: z.string().describe("Node name where the VM resides"),
        vmid: z.number().int().min(100).describe("VM ID to delete"),
      },
      annotations: REQUEST,
    },
    async ({ node, vmid }) =>
      safe("vm_delete_request", async () => {
        const { token, name } = await requestVmDelete(node, vmid);
        return (
          `⚠️ **VM Deletion Request — Step 1 of 2**\n\n` +
          `VM **${name}** (ID: ${vmid}) on node **${node}** is queued for deletion.\n\n` +
          "To permanently delete it, call `vm_delete_confirm` with:\n" +
          `- \`confirmation_token\`: \`${token}\`\n` +
          `- \`vm_name\`: \`${name}\`\n\n` +
          "⏰ Token expires in 5 minutes. This will permanently destroy the VM and all its local disks."
        );
      }),
  );

  server.registerTool(
    "vm_delete_confirm",
    {
      title: "Confirm VM Deletion (Step 2 of 2)",
      description:
        "Step 2 of 2: Permanently delete a QEMU VM. Requires the " +
        "confirmation_token from vm_delete_request AND the exact VM name. " +
        "WARNING: destroys the VM and all its local disks. Cannot be undone.",
      inputSchema: {
        confirmation_token: z.string().describe("Token from vm_delete_request"),
        vm_name: z.string().describe("Exact VM name returned by vm_delete_request"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ confirmation_token, vm_name }) =>
      safe("vm_delete_confirm", async () => {
        const task = await confirmVmDelete(confirmation_token, vm_name);
        return (
          `💀 VM **${vm_name}** deletion started.\nTask ID: \`${task}\`\n\n` +
          "The VM and all its local disks are being permanently destroyed."
        );
      }),
  );
}
