/**
 * Write tool for creating an LXC container from a template. confirm=false
 * (default) previews; confirm=true creates. A failed start_after_create is
 * surfaced rather than hidden.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ProxmoxError, proxmoxPost } from "../../proxmox.js";
import { safe } from "../../safe.js";

interface CreateArgs {
  node: string;
  ctid: number;
  hostname: string;
  ostemplate: string;
  storage: string;
  disk_gb: number;
  cores: number;
  memory_mb: number;
  swap_mb: number;
  password: string;
  ssh_public_key: string;
  unprivileged: boolean;
  onboot: boolean;
  start_after_create: boolean;
  nameserver: string;
  bridge: string;
}

async function createContainer(
  a: CreateArgs,
): Promise<{ task: string; startStatus: string | null }> {
  const params: Record<string, string | number> = {
    vmid: a.ctid,
    hostname: a.hostname,
    ostemplate: a.ostemplate,
    storage: a.storage,
    rootfs: `${a.storage}:${a.disk_gb}`,
    cores: a.cores,
    memory: a.memory_mb,
    swap: a.swap_mb,
    unprivileged: a.unprivileged ? 1 : 0,
    onboot: a.onboot ? 1 : 0,
    net0: `name=eth0,bridge=${a.bridge},ip=dhcp`,
  };
  if (a.password) params.password = a.password;
  if (a.ssh_public_key) params["ssh-public-keys"] = a.ssh_public_key;
  if (a.nameserver) params.nameserver = a.nameserver;

  const task = String(await proxmoxPost(`/nodes/${a.node}/lxc`, params));

  let startStatus: string | null = null;
  if (a.start_after_create) {
    try {
      await proxmoxPost(`/nodes/${a.node}/lxc/${a.ctid}/status/start`);
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
    "create_container",
    {
      title: "Create LXC Container",
      description:
        "Create a new LXC container from a template. confirm=false (default) " +
        "returns the config that WOULD be created; call again with confirm=true " +
        "to create it. The template must already exist on Proxmox storage.",
      inputSchema: {
        node: z.string().describe("Node to create the container on"),
        ctid: z
          .number()
          .int()
          .min(100)
          .max(999999)
          .describe("Unique container ID (100–999999). Must not already exist."),
        hostname: z.string().describe("Container hostname (alphanumeric, hyphens)"),
        ostemplate: z
          .string()
          .describe(
            "Template path on storage, e.g. 'local:vztmpl/debian-12-standard_amd64.tar.zst'",
          ),
        storage: z
          .string()
          .describe("Storage pool for the root disk (use list_storage)"),
        disk_gb: z.number().int().min(1).default(8).describe("Root disk size in GB"),
        cores: z.number().int().min(1).max(128).default(1).describe("CPU cores"),
        memory_mb: z.number().int().min(128).default(512).describe("Memory in MB"),
        swap_mb: z.number().int().min(0).default(512).describe("Swap in MB"),
        password: z
          .string()
          .default("")
          .describe("Root password. If omitted, password login is disabled."),
        ssh_public_key: z
          .string()
          .default("")
          .describe("SSH public key to inject into authorized_keys"),
        unprivileged: z
          .boolean()
          .default(true)
          .describe("Create as unprivileged (recommended)"),
        onboot: z
          .boolean()
          .default(false)
          .describe("Start container on Proxmox boot"),
        start_after_create: z
          .boolean()
          .default(false)
          .describe("Start the container immediately after creation"),
        nameserver: z
          .string()
          .default("")
          .describe("DNS nameserver IP (optional)"),
        bridge: z.string().default("vmbr0").describe("Network bridge for eth0"),
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
      safe("create_container", async () => {
        const config =
          `**Config:**\n` +
          `- Node: \`${args.node}\`\n` +
          `- Container ID: \`${args.ctid}\`  Hostname: \`${args.hostname}\`\n` +
          `- CPU: ${args.cores} core(s)\n` +
          `- Memory: ${args.memory_mb} MB\n` +
          `- Swap: ${args.swap_mb} MB\n` +
          `- Root disk: ${args.disk_gb} GB on \`${args.storage}\`\n` +
          `- Template: \`${args.ostemplate}\`\n` +
          `- Network: \`eth0\` on bridge \`${args.bridge}\` (dhcp)\n` +
          `- Unprivileged: ${args.unprivileged ? "yes" : "no"}\n` +
          `- Start on boot: ${args.onboot ? "yes" : "no"}\n` +
          `- Start after create: ${args.start_after_create ? "yes" : "no"}\n`;

        if (!args.confirm) {
          return (
            `🔎 **Review: container not yet created.**\n\n${config}\n` +
            "Call `create_container` again with the same arguments plus `confirm=true` to create it."
          );
        }

        const { task, startStatus } = await createContainer({
          node: args.node,
          ctid: args.ctid,
          hostname: args.hostname,
          ostemplate: args.ostemplate,
          storage: args.storage,
          disk_gb: args.disk_gb,
          cores: args.cores,
          memory_mb: args.memory_mb,
          swap_mb: args.swap_mb,
          password: args.password,
          ssh_public_key: args.ssh_public_key,
          unprivileged: args.unprivileged,
          onboot: args.onboot,
          start_after_create: args.start_after_create,
          nameserver: args.nameserver.trim(),
          bridge: args.bridge,
        });

        let startLine = "";
        if (startStatus === "ok") {
          startLine = "▶️ Start requested. The container is booting.\n";
        } else if (startStatus) {
          startLine =
            `⚠️ The container was created but the start request failed: ${startStatus.slice(8)}. ` +
            "Wait for provisioning to finish, then call `start_container`.\n";
        }

        return (
          `✅ Container **${args.hostname}** (ID: ${args.ctid}) creation started on node **${args.node}**.\n` +
          `Task ID: \`${task}\`\n${startLine}\n${config}\n` +
          "Use `get_container_status` to check when the container is ready."
        );
      }),
  );
}
