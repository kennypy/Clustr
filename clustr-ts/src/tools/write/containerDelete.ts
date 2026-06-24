/**
 * Two-step LXC container deletion: same pattern as vmDelete, keyed on hostname.
 */

import { randomBytes } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ProxmoxError, proxmoxDelete, proxmoxGet } from "../../proxmox.js";
import { safe } from "../../safe.js";
import { backupBeforeDestroyHint } from "../../backupHints.js";

const TOKEN_TTL_MS = 5 * 60 * 1000;

export interface PendingDelete {
  node: string;
  ctid: number;
  hostname: string;
  expires: number;
}

export const pendingDeletes = new Map<string, PendingDelete>();

const REQUEST = { readOnlyHint: false, destructiveHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;

function purgeExpired(): void {
  const now = Date.now();
  for (const [token, v] of pendingDeletes) {
    if (v.expires < now) pendingDeletes.delete(token);
  }
}

/** Validate + consume a token (pure; unit-testable). Throws on mismatch/expiry. */
export function consumeDeleteToken(
  token: string,
  hostname: string,
): PendingDelete {
  purgeExpired();
  const pending = pendingDeletes.get(token);
  if (!pending) {
    throw new ProxmoxError(
      "Confirmation token not found or expired. Call container_delete_request again to get a fresh token.",
    );
  }
  if (pending.hostname !== hostname) {
    throw new ProxmoxError(
      `Container hostname mismatch. Expected '${pending.hostname}', got '${hostname}'. ` +
        "Provide the exact hostname returned by container_delete_request.",
    );
  }
  pendingDeletes.delete(token);
  return pending;
}

async function requestContainerDelete(
  node: string,
  ctid: number,
): Promise<{ token: string; hostname: string }> {
  let config: Record<string, any>;
  try {
    config = (await proxmoxGet(`/nodes/${node}/lxc/${ctid}/config`)) as Record<
      string,
      any
    >;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProxmoxError(`Container ${ctid} not found on node '${node}': ${msg}`);
  }
  const hostname = config.hostname ?? `ct-${ctid}`;

  const status = (await proxmoxGet(
    `/nodes/${node}/lxc/${ctid}/status/current`,
  )) as Record<string, any>;
  if (status.status === "running") {
    throw new ProxmoxError(
      `Container ${ctid} (${hostname}) is currently running. Stop it before requesting deletion.`,
    );
  }

  const token = randomBytes(16).toString("hex");
  pendingDeletes.set(token, {
    node,
    ctid,
    hostname,
    expires: Date.now() + TOKEN_TTL_MS,
  });
  return { token, hostname };
}

async function confirmContainerDelete(
  token: string,
  hostname: string,
): Promise<string> {
  const { node, ctid, hostname: name } = consumeDeleteToken(token, hostname);

  let config: Record<string, any>;
  try {
    config = (await proxmoxGet(`/nodes/${node}/lxc/${ctid}/config`)) as Record<
      string,
      any
    >;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProxmoxError(
      `Could not verify container ${ctid} on node '${node}' before deletion (it ` +
        `may no longer exist); nothing was deleted: ${msg}`,
    );
  }
  const currentHostname = config.hostname ?? `ct-${ctid}`;
  if (currentHostname !== name) {
    throw new ProxmoxError(
      `Container ${ctid} is now named '${currentHostname}', not '${name}'. The ` +
        "CTID may have been reused since the delete request. Nothing was deleted. " +
        "Call container_delete_request again.",
    );
  }

  const task = await proxmoxDelete(`/nodes/${node}/lxc/${ctid}`, {
    purge: 1,
    "destroy-unreferenced-disks": 1,
  });
  return String(task);
}

export function register(server: McpServer): void {
  server.registerTool(
    "container_delete_request",
    {
      title: "Request Container Deletion (Step 1 of 2)",
      description:
        "Step 1 of 2: Request deletion of an LXC container. Returns a " +
        "confirmation token and the hostname. You MUST call " +
        "container_delete_confirm with the token and exact hostname. Token " +
        "expires in 5 minutes. The container must be stopped.",
      inputSchema: {
        node: z.string().describe("Node name where the container resides"),
        ctid: z.number().int().min(100).describe("Container ID to delete"),
      },
      annotations: REQUEST,
    },
    async ({ node, ctid }) =>
      safe("container_delete_request", async () => {
        const { token, hostname } = await requestContainerDelete(node, ctid);
        const hint = await backupBeforeDestroyHint(node, "container");
        return (
          `⚠️ **Container Deletion Request: Step 1 of 2**\n\n` +
          `Container **${hostname}** (ID: ${ctid}) on node **${node}** is queued for deletion.\n\n` +
          "To permanently delete it, call `container_delete_confirm` with:\n" +
          `- \`confirmation_token\`: \`${token}\`\n` +
          `- \`container_hostname\`: \`${hostname}\`\n\n` +
          "⏰ Token expires in 5 minutes. This will permanently destroy the container and all its local storage." +
          hint
        );
      }),
  );

  server.registerTool(
    "container_delete_confirm",
    {
      title: "Confirm Container Deletion (Step 2 of 2)",
      description:
        "Step 2 of 2: Permanently delete an LXC container. Requires the " +
        "confirmation_token from container_delete_request AND the exact " +
        "hostname. WARNING: destroys the container and all its local storage. " +
        "Cannot be undone.",
      inputSchema: {
        confirmation_token: z
          .string()
          .describe("Token from container_delete_request"),
        container_hostname: z
          .string()
          .describe("Exact hostname returned by container_delete_request"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ confirmation_token, container_hostname }) =>
      safe("container_delete_confirm", async () => {
        const task = await confirmContainerDelete(
          confirmation_token,
          container_hostname,
        );
        return (
          `💀 Container **${container_hostname}** deletion started.\nTask ID: \`${task}\`\n\n` +
          "The container and all its local storage are being permanently destroyed."
        );
      }),
  );
}
