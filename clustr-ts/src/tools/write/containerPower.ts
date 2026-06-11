/**
 * Write tools for LXC container power management. LXC has no hard "reset", so
 * only stop (force) is destructive.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxmoxPost } from "../../proxmox.js";
import { needsConfirm, safe } from "../../safe.js";

const SAFE_WRITE = { readOnlyHint: false, destructiveHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;

const node = z.string().describe("Node name (e.g. 'pve')");
const ctid = z.number().int().min(100).describe("Container ID");
const confirm = z
  .boolean()
  .default(false)
  .describe(
    "Must be true to execute this destructive operation. When false (default), " +
      "returns a confirmation prompt without acting.",
  );

async function run(n: string, id: number, action: string): Promise<string> {
  const task = await proxmoxPost(`/nodes/${n}/lxc/${id}/status/${action}`);
  return (
    `✅ Container ${id} on ${n}: **${action}** initiated.\n` +
    `Task ID: \`${String(task)}\`\n\n` +
    "Use `get_container_status` to check the current state."
  );
}

export function register(server: McpServer): void {
  server.registerTool(
    "start_container",
    {
      title: "Start Container",
      description: "Start a stopped LXC container. No effect if already running.",
      inputSchema: { node, ctid },
      annotations: SAFE_WRITE,
    },
    async ({ node: n, ctid: id }) =>
      safe("start_container", () => run(n, id, "start")),
  );

  server.registerTool(
    "shutdown_container",
    {
      title: "Shutdown Container (Graceful)",
      description:
        "Gracefully shut down an LXC container (signals init). Use " +
        "stop_container if it is unresponsive.",
      inputSchema: { node, ctid },
      annotations: SAFE_WRITE,
    },
    async ({ node: n, ctid: id }) =>
      safe("shutdown_container", () => run(n, id, "shutdown")),
  );

  server.registerTool(
    "stop_container",
    {
      title: "Stop Container (Force)",
      description:
        "Force-stop an LXC container immediately. Data loss may occur. Prefer " +
        "shutdown_container for a graceful stop.",
      inputSchema: { node, ctid, confirm },
      annotations: DESTRUCTIVE,
    },
    async ({ node: n, ctid: id, confirm: ok }) =>
      safe("stop_container", async () =>
        ok
          ? run(n, id, "stop")
          : needsConfirm("force-stop", `container ${id} on ${n}`),
      ),
  );

  server.registerTool(
    "reboot_container",
    {
      title: "Reboot Container (Graceful)",
      description: "Gracefully reboot a running LXC container.",
      inputSchema: { node, ctid },
      annotations: SAFE_WRITE,
    },
    async ({ node: n, ctid: id }) =>
      safe("reboot_container", () => run(n, id, "reboot")),
  );
}
