/**
 * Local APT tools: the cheap, no-internet endpoints the Node → Updates panel
 * uses. list_node_updates answers "what updates are pending" without reaching
 * out to the internet (unlike the roadmap fetch in check_proxmox_updates).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxmoxGet } from "../../proxmox.js";
import { safe } from "../../safe.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

interface AptPkg {
  Package?: string;
  Title?: string;
  Version?: string;
  OldVersion?: string;
  Priority?: string;
}

/** Shared: pending update count + whether a kernel/pve-manager update is among them. */
export async function pendingUpdates(node: string): Promise<{
  count: number;
  notable: string[];
}> {
  const pkgs = (await proxmoxGet(`/nodes/${node}/apt/update`)) as AptPkg[];
  const notable = pkgs
    .map((p) => String(p.Package ?? ""))
    .filter((n) => /kernel|pve-manager|pve-kernel|proxmox-kernel/.test(n));
  return { count: pkgs.length, notable };
}

export function register(server: McpServer): void {
  server.registerTool(
    "list_node_updates",
    {
      title: "List Pending Updates",
      description:
        "List pending APT package updates on a node (the Node → Updates panel, " +
        "via /nodes/{node}/apt/update). Local and instant, no internet needed. " +
        "Highlights kernel / pve-manager updates.",
      inputSchema: { node: z.string().describe("Node name (e.g. 'pve')") },
      annotations: READ,
    },
    async ({ node }) =>
      safe("list_node_updates", async () => {
        const pkgs = (await proxmoxGet(`/nodes/${node}/apt/update`)) as AptPkg[];
        if (!pkgs.length) return `✅ ${node} is up to date: no pending package updates.`;
        const kernelish = pkgs.filter((p) =>
          /kernel|pve-manager/.test(String(p.Package ?? "")),
        );
        const lines = [`## ${pkgs.length} pending update(s) on ${node}\n`];
        if (kernelish.length) {
          lines.push(
            `⚠️ Includes kernel/PVE: ${kernelish.map((p) => p.Package).join(", ")} (reboot likely needed)\n`,
          );
        }
        for (const p of pkgs.slice(0, 60)) {
          lines.push(`- **${p.Package}** ${p.OldVersion ?? "?"} → ${p.Version ?? "?"}`);
        }
        if (pkgs.length > 60) lines.push(`\n…and ${pkgs.length - 60} more.`);
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "list_apt_repositories",
    {
      title: "List APT Repositories",
      description:
        "Show which Proxmox APT repositories are configured/enabled on a node " +
        "(enterprise / no-subscription / test), plus any repo warnings. Explains " +
        "why updates do or don't appear.",
      inputSchema: { node: z.string().describe("Node name (e.g. 'pve')") },
      annotations: READ,
    },
    async ({ node }) =>
      safe("list_apt_repositories", async () => {
        const data = (await proxmoxGet(
          `/nodes/${node}/apt/repositories`,
        )) as Record<string, any>;
        const std = (data["standard-repos"] ?? []) as Record<string, any>[];
        const lines = [`## APT repositories on ${node}\n`];
        if (std.length) {
          lines.push("**Standard repos:**");
          for (const r of std) {
            const status =
              r.status === 1 ? "✅ enabled" : r.status === 0 ? "⚫ disabled" : "— not configured";
            lines.push(`- ${r.name ?? r.handle} (${r.handle}) - ${status}`);
          }
        }
        const errors = (data.errors ?? []) as Record<string, any>[];
        if (errors.length) {
          lines.push("\n**Warnings:**");
          for (const e of errors.slice(0, 10)) lines.push(`- ${e.error ?? e.path ?? JSON.stringify(e)}`);
        }
        return lines.join("\n");
      }),
  );
}
