/**
 * Write tools to migrate a VM or container to another node in the cluster.
 *
 * Migration is non-destructive (Proxmox rolls back on failure), but it's a
 * significant operation, so we auto-pick the right mode based on whether the
 * guest is running: a running VM live-migrates (online); a running container
 * uses restart-migration (brief downtime). Both return a UPID to follow.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxmoxGet, proxmoxPost } from "../../proxmox.js";
import { safe } from "../../safe.js";

const WRITE = { readOnlyHint: false, destructiveHint: false } as const;

async function isRunning(path: string): Promise<boolean> {
  const s = (await proxmoxGet(`${path}/status/current`)) as { status?: string };
  return s.status === "running";
}

export function register(server: McpServer): void {
  server.registerTool(
    "migrate_vm",
    {
      title: "Migrate VM to Another Node",
      description:
        "Move a QEMU VM to another node in the cluster. A running VM is " +
        "live-migrated (no downtime) automatically; a stopped one is moved " +
        "offline. If the VM has disks on local (non-shared) storage, set " +
        "with_local_disks=true so the disks come along.",
      inputSchema: {
        node: z.string().describe("Current node the VM is on"),
        vmid: z.number().int().min(100).describe("VM ID"),
        target: z.string().describe("Destination node name"),
        online: z
          .boolean()
          .optional()
          .describe("Force online/offline. Default: auto (online if running)."),
        with_local_disks: z
          .boolean()
          .default(false)
          .describe("Migrate local-storage disks too (needed for non-shared storage)"),
      },
      annotations: WRITE,
    },
    async ({ node, vmid, target, online, with_local_disks }) =>
      safe("migrate_vm", async () => {
        const live = online ?? (await isRunning(`/nodes/${node}/qemu/${vmid}`));
        const body: Record<string, string | number> = {
          target,
          online: live ? 1 : 0,
        };
        if (with_local_disks) body["with-local-disks"] = 1;
        const task = await proxmoxPost(`/nodes/${node}/qemu/${vmid}/migrate`, body);
        return (
          `✅ Migrating VM ${vmid}: ${node} → ${target} ` +
          `(${live ? "online/live" : "offline"}).\n` +
          `Task ID: \`${String(task)}\`\n\nUse \`get_task_status\` to follow it.`
        );
      }),
  );

  server.registerTool(
    "migrate_container",
    {
      title: "Migrate Container to Another Node",
      description:
        "Move an LXC container to another node. A running container uses " +
        "restart-migration (it is briefly stopped, moved, and restarted); a " +
        "stopped one is moved offline. LXC has no live migration.",
      inputSchema: {
        node: z.string().describe("Current node the container is on"),
        ctid: z.number().int().min(100).describe("Container ID"),
        target: z.string().describe("Destination node name"),
        restart: z
          .boolean()
          .optional()
          .describe("Force restart-migration. Default: auto (restart if running)."),
      },
      annotations: WRITE,
    },
    async ({ node, ctid, target, restart }) =>
      safe("migrate_container", async () => {
        const running =
          restart ?? (await isRunning(`/nodes/${node}/lxc/${ctid}`));
        const body: Record<string, string | number> = {
          target,
          restart: running ? 1 : 0,
        };
        const task = await proxmoxPost(`/nodes/${node}/lxc/${ctid}/migrate`, body);
        return (
          `✅ Migrating container ${ctid}: ${node} → ${target} ` +
          `(${running ? "restart-migration, brief downtime" : "offline"}).\n` +
          `Task ID: \`${String(task)}\`\n\nUse \`get_task_status\` to follow it.`
        );
      }),
  );
}
