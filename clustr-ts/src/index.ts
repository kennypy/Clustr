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
import { register as registerBackupsList } from "./tools/read/backups.js";
import { register as registerStorageContent } from "./tools/read/storageContent.js";
import { register as registerTasks } from "./tools/read/tasks.js";
import { register as registerVmPower } from "./tools/write/vmPower.js";
import { register as registerContainerPower } from "./tools/write/containerPower.js";
import { register as registerVmSnapshots } from "./tools/write/vmSnapshots.js";
import { register as registerContainerSnapshots } from "./tools/write/containerSnapshots.js";
import { register as registerVmDelete } from "./tools/write/vmDelete.js";
import { register as registerContainerDelete } from "./tools/write/containerDelete.js";
import { register as registerVmCreate } from "./tools/write/vmCreate.js";
import { register as registerContainerCreate } from "./tools/write/containerCreate.js";
import { register as registerVmBackup } from "./tools/write/vmBackup.js";
import { register as registerVmRestore } from "./tools/write/vmRestore.js";
import { register as registerVmConfig } from "./tools/write/vmConfig.js";
import { register as registerContainerConfig } from "./tools/write/containerConfig.js";
import { register as registerClone } from "./tools/write/clone.js";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "clustr", version: "0.1.0" });
  // Read
  registerNodes(server);
  registerVms(server);
  registerContainers(server);
  registerStorage(server);
  registerUpdates(server);
  registerBackupsList(server);
  registerStorageContent(server);
  registerTasks(server);
  // Write
  registerVmPower(server);
  registerContainerPower(server);
  registerVmSnapshots(server);
  registerContainerSnapshots(server);
  registerVmDelete(server);
  registerContainerDelete(server);
  registerVmCreate(server);
  registerContainerCreate(server);
  registerVmBackup(server);
  registerVmRestore(server);
  registerVmConfig(server);
  registerContainerConfig(server);
  registerClone(server);
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
