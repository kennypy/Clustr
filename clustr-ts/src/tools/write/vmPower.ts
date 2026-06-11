/**
 * Write tools for QEMU VM power management.
 *
 * start / shutdown / reboot are non-destructive; stop (force) and reset (hard)
 * are destructive and gated behind confirm=true.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxmoxPost } from "../../proxmox.js";
import { needsConfirm, safe } from "../../safe.js";

const SAFE_WRITE = { readOnlyHint: false, destructiveHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;

const node = z.string().describe("Node name (e.g. 'pve')");
const vmid = z.number().int().min(100).describe("VM ID");
const confirm = z
  .boolean()
  .default(false)
  .describe(
    "Must be true to execute this destructive operation. When false (default), " +
      "returns a confirmation prompt without acting.",
  );

async function run(n: string, id: number, action: string): Promise<string> {
  const task = await proxmoxPost(`/nodes/${n}/qemu/${id}/status/${action}`);
  return (
    `✅ VM ${id} on ${n}: **${action}** initiated.\n` +
    `Task ID: \`${String(task)}\`\n\n` +
    "Use `get_vm_status` to check the current state."
  );
}

export function register(server: McpServer): void {
  server.registerTool(
    "start_vm",
    {
      title: "Start VM",
      description:
        "Start a stopped QEMU virtual machine. No effect if already running.",
      inputSchema: { node, vmid },
      annotations: SAFE_WRITE,
    },
    async ({ node: n, vmid: id }) => safe("start_vm", () => run(n, id, "start")),
  );

  server.registerTool(
    "shutdown_vm",
    {
      title: "Shutdown VM (Graceful)",
      description:
        "Send a graceful ACPI shutdown to a QEMU VM. The guest OS handles it. " +
        "Use stop_vm if the guest is unresponsive.",
      inputSchema: { node, vmid },
      annotations: SAFE_WRITE,
    },
    async ({ node: n, vmid: id }) =>
      safe("shutdown_vm", () => run(n, id, "shutdown")),
  );

  server.registerTool(
    "stop_vm",
    {
      title: "Stop VM (Force)",
      description:
        "Force-stop a QEMU VM immediately, like pulling the power cable. Data " +
        "loss may occur. Prefer shutdown_vm unless the guest is unresponsive.",
      inputSchema: { node, vmid, confirm },
      annotations: DESTRUCTIVE,
    },
    async ({ node: n, vmid: id, confirm: ok }) =>
      safe("stop_vm", async () =>
        ok ? run(n, id, "stop") : needsConfirm("force-stop", `VM ${id} on ${n}`),
      ),
  );

  server.registerTool(
    "reboot_vm",
    {
      title: "Reboot VM (Graceful)",
      description: "Send a graceful ACPI reboot to a running QEMU VM.",
      inputSchema: { node, vmid },
      annotations: SAFE_WRITE,
    },
    async ({ node: n, vmid: id }) => safe("reboot_vm", () => run(n, id, "reboot")),
  );

  server.registerTool(
    "reset_vm",
    {
      title: "Reset VM (Hard Reset)",
      description:
        "Hard-reset a QEMU VM, like the physical reset button. Data loss may " +
        "occur. Prefer reboot_vm for a graceful restart.",
      inputSchema: { node, vmid, confirm },
      annotations: DESTRUCTIVE,
    },
    async ({ node: n, vmid: id, confirm: ok }) =>
      safe("reset_vm", async () =>
        ok ? run(n, id, "reset") : needsConfirm("hard-reset", `VM ${id} on ${n}`),
      ),
  );
}
