/**
 * Manage the configured Proxmox endpoints conversationally: list, add, remove.
 * add/remove persist to CLUSTR_ENDPOINTS_FILE (so they survive restarts); if
 * that isn't set, they explain how to enable persistence rather than failing
 * silently. Secrets are never echoed back.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  addEndpoint,
  defaultEndpointName,
  endpoints,
  removeEndpoint,
} from "../../endpoints.js";
import { safe } from "../../safe.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;
const WRITE = { readOnlyHint: false, destructiveHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;

export function register(server: McpServer): void {
  server.registerTool(
    "list_endpoints",
    {
      title: "List Proxmox Endpoints",
      description:
        "List the Proxmox clusters/hosts this Clustr instance manages (name, " +
        "host, user). Pass an endpoint's name as the `host` argument on other " +
        "tools to target it. Secrets are not shown.",
      annotations: READ,
    },
    async () =>
      safe("list_endpoints", async () => {
        const eps = endpoints();
        if (!eps.length) return "No Proxmox endpoints configured.";
        const def = defaultEndpointName();
        const lines = [`## Endpoints (${eps.length})\n`];
        for (const e of eps) {
          lines.push(
            `- **${e.name}**${e.name === def ? " (default)" : ""} - ${e.user}@${e.host}:${e.port}` +
              (e.verifySsl ? "" : " (TLS verify off)"),
          );
        }
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "add_endpoint",
    {
      title: "Add Proxmox Endpoint",
      description:
        "Add (or update) a Proxmox endpoint so Clustr can manage another cluster/" +
        "host. Persists to CLUSTR_ENDPOINTS_FILE. Use a least-privilege API token.",
      inputSchema: {
        name: z.string().describe("Short label for this endpoint, e.g. 'office'"),
        address: z.string().describe("Proxmox IP or hostname"),
        token_name: z.string().describe("API token ID"),
        token_value: z.string().describe("API token secret"),
        user: z.string().default("root@pam").describe("User with realm"),
        port: z.number().int().min(1).max(65535).default(8006).describe("API port"),
        verify_ssl: z.boolean().default(false).describe("Verify TLS certificate"),
      },
      annotations: WRITE,
    },
    async ({ name, address, token_name, token_value, user, port, verify_ssl }) =>
      safe("add_endpoint", async () => {
        try {
          const ep = addEndpoint({
            name,
            host: address,
            user,
            port,
            tokenName: token_name,
            tokenValue: token_value,
            verifySsl: verify_ssl,
          });
          return `✅ Endpoint **${ep.name}** added (${ep.user}@${ep.host}:${ep.port}). Target it with \`host: ${ep.name}\`.`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Could not add endpoint: ${msg}`;
        }
      }),
  );

  server.registerTool(
    "remove_endpoint",
    {
      title: "Remove Proxmox Endpoint",
      description:
        "Remove a configured Proxmox endpoint by name. Persists to " +
        "CLUSTR_ENDPOINTS_FILE. Does not touch the Proxmox cluster itself.",
      inputSchema: { name: z.string().describe("Endpoint name to remove") },
      annotations: DESTRUCTIVE,
    },
    async ({ name }) =>
      safe("remove_endpoint", async () => {
        try {
          return removeEndpoint(name)
            ? `✅ Endpoint **${name}** removed.`
            : `No endpoint named '${name}'.`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Could not remove endpoint: ${msg}`;
        }
      }),
  );
}
