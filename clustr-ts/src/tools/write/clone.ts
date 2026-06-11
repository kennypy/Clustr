/**
 * Write tools to clone a QEMU VM or LXC container (including from a template).
 * Additive — creates a new guest at a new ID; the source is untouched. A linked
 * clone (default for templates) is fast and space-efficient; full=true makes an
 * independent full copy.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxmoxPost } from "../../proxmox.js";
import { safe } from "../../safe.js";

const WRITE = { readOnlyHint: false, destructiveHint: false } as const;

export function register(server: McpServer): void {
  server.registerTool(
    "clone_vm",
    {
      title: "Clone VM",
      description:
        "Clone a QEMU VM (or VM template) into a new VM ID. full=true makes an " +
        "independent full copy; otherwise a linked clone (fast, requires the " +
        "source to be a template for most storages). The source VM is unchanged.",
      inputSchema: {
        node: z.string().describe("Node where the source VM resides"),
        vmid: z.number().int().min(100).describe("Source VM ID to clone from"),
        newid: z
          .number()
          .int()
          .min(100)
          .max(999999)
          .describe("New VM ID for the clone (must not exist)"),
        name: z.string().optional().describe("Name for the new VM"),
        full: z
          .boolean()
          .default(false)
          .describe("Full clone (independent copy). Default: linked clone."),
        storage: z
          .string()
          .optional()
          .describe("Target storage for a full clone's disks"),
        target: z
          .string()
          .optional()
          .describe("Target node (for cross-node clone in a cluster)"),
      },
      annotations: WRITE,
    },
    async ({ node, vmid, newid, name, full, storage, target }) =>
      safe("clone_vm", async () => {
        const body: Record<string, string | number> = { newid };
        if (name) body.name = name;
        if (full) body.full = 1;
        if (storage) body.storage = storage;
        if (target) body.target = target;
        const task = await proxmoxPost(`/nodes/${node}/qemu/${vmid}/clone`, body);
        return (
          `✅ Cloning VM ${vmid} → ${newid}${name ? ` (${name})` : ""} ` +
          `(${full ? "full" : "linked"} clone) started on ${node}.\n` +
          `Task ID: \`${String(task)}\`\n\nUse \`get_task_status\` to follow it.`
        );
      }),
  );

  server.registerTool(
    "clone_container",
    {
      title: "Clone Container",
      description:
        "Clone an LXC container (or template) into a new container ID. full=true " +
        "makes an independent copy; otherwise a linked clone. The source is " +
        "unchanged.",
      inputSchema: {
        node: z.string().describe("Node where the source container resides"),
        ctid: z.number().int().min(100).describe("Source container ID"),
        newid: z
          .number()
          .int()
          .min(100)
          .max(999999)
          .describe("New container ID for the clone (must not exist)"),
        hostname: z.string().optional().describe("Hostname for the new container"),
        full: z
          .boolean()
          .default(false)
          .describe("Full clone (independent copy). Default: linked clone."),
        storage: z
          .string()
          .optional()
          .describe("Target storage for a full clone"),
        target: z.string().optional().describe("Target node (cross-node clone)"),
      },
      annotations: WRITE,
    },
    async ({ node, ctid, newid, hostname, full, storage, target }) =>
      safe("clone_container", async () => {
        const body: Record<string, string | number> = { newid };
        if (hostname) body.hostname = hostname;
        if (full) body.full = 1;
        if (storage) body.storage = storage;
        if (target) body.target = target;
        const task = await proxmoxPost(`/nodes/${node}/lxc/${ctid}/clone`, body);
        return (
          `✅ Cloning container ${ctid} → ${newid}${hostname ? ` (${hostname})` : ""} ` +
          `(${full ? "full" : "linked"} clone) started on ${node}.\n` +
          `Task ID: \`${String(task)}\`\n\nUse \`get_task_status\` to follow it.`
        );
      }),
  );
}
