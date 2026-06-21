/**
 * MCP prompts — these surface in Claude's slash (/) menu, so typing "/clustr"
 * drops you straight into a Proxmox session with the chat primed. Prompts are
 * just templated opening messages; the tools do the work.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function register(server: McpServer): void {
  server.registerPrompt(
    "clustr",
    {
      title: "Clustr — Proxmox session",
      description:
        "Start a Proxmox management session: a quick health overview, then ready " +
        "to manage nodes, VMs, containers, storage, and backups.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "You're my Proxmox infrastructure assistant via the Clustr tools. " +
              "Start with a concise health overview of my cluster — nodes and their " +
              "CPU/RAM/disk, running vs stopped VMs and containers, storage usage, and " +
              "anything that needs attention (full/failing storage, guests with no " +
              "backup, failed tasks, pending updates). Use cluster_review for a full " +
              "audit, or the lighter list_* tools for a quick look. Then ask what I'd " +
              "like to do. Before anything destructive (stop / delete / restore / " +
              "rollback), confirm with me first.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "clustr-setup",
    {
      title: "Clustr — set up / get an API token",
      description:
        "Guided first-time setup: turn your Proxmox host IP into a correctly-scoped " +
        "API token and wire it into Clustr.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Help me set up Clustr for my Proxmox cluster. Ask me for my Proxmox " +
              "host IP (and whether I want full management or read-only), then call " +
              "the setup_clustr tool to give me the login link and the exact snippet " +
              "to create an API token with the right permissions. Walk me through " +
              "copying the token secret back. If I'd rather not paste a snippet and " +
              "I'm comfortable giving a one-time admin login, offer to provision the " +
              "token over the API instead (confirm before doing it).",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "clustr-review",
    {
      title: "Clustr — full cluster review",
      description: "Run a comprehensive Proxmox review and give a prioritized summary.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Run a full review of my Proxmox cluster with the cluster_review tool, " +
              "then give me a prioritized summary: what's broken or risky first (P1), " +
              "then what to fix soon, then what to watch. Be specific about which " +
              "guests/nodes and why it matters — especially anything with no backup, " +
              "storage over ~85%, failing disks, sustained high RAM/CPU, expiring TLS " +
              "certs, and recent failed tasks.",
          },
        },
      ],
    }),
  );
}
