/**
 * Write tool for creating a QEMU VM. confirm=false (default) previews the exact
 * config and creates nothing; confirm=true creates it. A failed
 * start_after_create is surfaced, never hidden behind a success message.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ProxmoxError, proxmoxPost } from "../../proxmox.js";
import { safe } from "../../safe.js";

const OS_TYPES = [
  "l26",
  "l24",
  "win11",
  "win10",
  "win8",
  "win7",
  "wxp",
  "solaris",
  "other",
] as const;

interface CreateArgs {
  node: string;
  vmid: number;
  name: string;
  cores: number;
  memory_mb: number;
  disk_gb: number;
  storage: string;
  os_type: string;
  iso_path: string;
  bridge: string;
  onboot: boolean;
  start_after_create: boolean;
}

async function createVm(
  a: CreateArgs,
): Promise<{ task: string; startStatus: string | null }> {
  const params: Record<string, string | number> = {
    vmid: a.vmid,
    name: a.name,
    cores: a.cores,
    sockets: 1,
    memory: a.memory_mb,
    ostype: a.os_type,
    onboot: a.onboot ? 1 : 0,
    agent: "enabled=1",
    scsi0: `${a.storage}:${a.disk_gb}`,
    scsihw: "virtio-scsi-pci",
    boot: "order=scsi0",
    net0: `virtio,bridge=${a.bridge}`,
    vga: "std",
    tablet: 1,
  };
  if (a.iso_path) {
    params.ide2 = `${a.iso_path},media=cdrom`;
    params.boot = "order=ide2;scsi0";
  }

  const task = String(await proxmoxPost(`/nodes/${a.node}/qemu`, params));

  let startStatus: string | null = null;
  if (a.start_after_create) {
    try {
      await proxmoxPost(`/nodes/${a.node}/qemu/${a.vmid}/status/start`);
      startStatus = "ok";
    } catch (err) {
      const msg = err instanceof ProxmoxError ? err.message : String(err);
      startStatus = `failed: ${msg}`;
    }
  }
  return { task, startStatus };
}

export function register(server: McpServer): void {
  server.registerTool(
    "create_vm",
    {
      title: "Create Virtual Machine",
      description:
        "Create a new QEMU VM on a Proxmox node. confirm=false (default) returns " +
        "the exact config that WOULD be created, for review; call again with " +
        "confirm=true to create it. An ISO on Proxmox storage can be attached " +
        "as a CD-ROM for OS install.",
      inputSchema: {
        node: z.string().describe("Node to create the VM on (e.g. 'pve')"),
        vmid: z
          .number()
          .int()
          .min(100)
          .max(999999)
          .describe("Unique VM ID (100–999999). Must not already exist."),
        name: z.string().describe("VM name (alphanumeric, hyphens; max 64 chars)"),
        cores: z.number().int().min(1).max(128).default(2).describe("CPU cores"),
        memory_mb: z.number().int().min(256).default(2048).describe("Memory in MB"),
        disk_gb: z.number().int().min(1).default(32).describe("Primary disk GB"),
        storage: z
          .string()
          .default("local-lvm")
          .describe("Storage pool for the disk (use list_storage to find pools)"),
        os_type: z.enum(OS_TYPES).default("l26").describe("OS type hint"),
        iso_path: z
          .string()
          .default("")
          .describe(
            "Optional ISO on Proxmox storage, e.g. 'local:iso/ubuntu.iso'. Empty for diskless.",
          ),
        bridge: z.string().default("vmbr0").describe("Network bridge for the NIC"),
        onboot: z.boolean().default(false).describe("Start VM on Proxmox boot"),
        start_after_create: z
          .boolean()
          .default(false)
          .describe("Start the VM immediately after creation"),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Must be true to actually create. When false (default), previews the config.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) =>
      safe("create_vm", async () => {
        const iso = args.iso_path.trim();
        const config =
          `**Config:**\n` +
          `- Node: \`${args.node}\`\n` +
          `- VM ID: \`${args.vmid}\`  Name: \`${args.name}\`\n` +
          `- CPU: ${args.cores} core(s)\n` +
          `- Memory: ${args.memory_mb} MB\n` +
          `- Disk: ${args.disk_gb} GB on \`${args.storage}\`\n` +
          `- OS type: \`${args.os_type}\`\n` +
          `- ISO: \`${iso || "none"}\`\n` +
          `- Network: \`virtio\` on bridge \`${args.bridge}\`\n` +
          `- Start on boot: ${args.onboot ? "yes" : "no"}\n` +
          `- Start after create: ${args.start_after_create ? "yes" : "no"}\n`;

        if (!args.confirm) {
          return (
            `🔎 **Review: VM not yet created.**\n\n${config}\n` +
            "Call `create_vm` again with the same arguments plus `confirm=true` to create it."
          );
        }

        const { task, startStatus } = await createVm({
          node: args.node,
          vmid: args.vmid,
          name: args.name,
          cores: args.cores,
          memory_mb: args.memory_mb,
          disk_gb: args.disk_gb,
          storage: args.storage,
          os_type: args.os_type,
          iso_path: iso,
          bridge: args.bridge,
          onboot: args.onboot,
          start_after_create: args.start_after_create,
        });

        let startLine = "";
        if (startStatus === "ok") {
          startLine = "▶️ Start requested. The VM is booting.\n";
        } else if (startStatus) {
          startLine =
            `⚠️ The VM was created but the start request failed: ${startStatus.slice(8)}. ` +
            "This usually means the disk is still being allocated; wait a moment, then call `start_vm`.\n";
        }

        return (
          `✅ VM **${args.name}** (ID: ${args.vmid}) creation started on node **${args.node}**.\n` +
          `Task ID: \`${task}\`\n${startLine}\n${config}\n` +
          "Use `get_vm_status` to check when the VM is ready."
        );
      }),
  );
}
