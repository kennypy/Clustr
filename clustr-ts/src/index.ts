#!/usr/bin/env node
/**
 * Clustr MCP server (TypeScript) — entry point.
 *
 * Runs over stdio as a local subprocess (the model of a Claude Desktop / MCPB
 * extension): no network port, no bind, no transport-auth surface. Safety comes
 * from it being local plus the scope of the Proxmox API token it is given.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { register as registerNodes } from "./tools/read/nodes.js";
import { register as registerVms } from "./tools/read/vms.js";
import { register as registerContainers } from "./tools/read/containers.js";
import { register as registerStorage } from "./tools/read/storage.js";
import { register as registerUpdates } from "./tools/read/updates.js";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "clustr", version: "0.1.0" });
  registerNodes(server);
  registerVms(server);
  registerContainers(server);
  registerStorage(server);
  registerUpdates(server);
  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("Clustr failed to start:", err);
  process.exit(1);
});
