#!/usr/bin/env node
/**
 * Clustr MCP server (TypeScript): entry point.
 *
 * Runs over stdio as a local subprocess (the model of a Claude Desktop / MCPB
 * extension): no network port, no bind, no transport-auth surface. Safety comes
 * from it being local plus the scope of the Proxmox API token it is given.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { register as registerPrompts } from "./prompts.js";
import { patchForMultiHost } from "./multihost.js";
import { register as registerEndpoints } from "./tools/read/endpoints.js";
import { register as registerSetup } from "./tools/write/setup.js";

import { register as registerNodes } from "./tools/read/nodes.js";
import { register as registerVms } from "./tools/read/vms.js";
import { register as registerContainers } from "./tools/read/containers.js";
import { register as registerStorage } from "./tools/read/storage.js";
import { register as registerUpdates } from "./tools/read/updates.js";
import { register as registerBackupsList } from "./tools/read/backups.js";
import { register as registerStorageContent } from "./tools/read/storageContent.js";
import { register as registerTasks } from "./tools/read/tasks.js";
import { register as registerBackupJobs } from "./tools/read/backupJobs.js";
import { register as registerApt } from "./tools/read/apt.js";
import { register as registerMetrics } from "./tools/read/metrics.js";
import { register as registerPools } from "./tools/read/pools.js";
import { register as registerNetwork } from "./tools/read/network.js";
import { register as registerCluster } from "./tools/read/cluster.js";
import { register as registerReview } from "./tools/read/review.js";
import { register as registerDownloads } from "./tools/write/downloads.js";
import { register as registerVmPower } from "./tools/write/vmPower.js";
import { register as registerContainerPower } from "./tools/write/containerPower.js";
import { register as registerVmSnapshots } from "./tools/write/vmSnapshots.js";
import { register as registerContainerSnapshots } from "./tools/write/containerSnapshots.js";
import { register as registerVmDelete } from "./tools/write/vmDelete.js";
import { register as registerContainerDelete } from "./tools/write/containerDelete.js";
import { register as registerVmCreate } from "./tools/write/vmCreate.js";
import { register as registerContainerCreate } from "./tools/write/containerCreate.js";
import { register as registerVmBackup } from "./tools/write/vmBackup.js";
import { register as registerContainerBackup } from "./tools/write/containerBackup.js";
import { register as registerVmRestore } from "./tools/write/vmRestore.js";
import { register as registerContainerRestore } from "./tools/write/containerRestore.js";
import { register as registerVmConfig } from "./tools/write/vmConfig.js";
import { register as registerContainerConfig } from "./tools/write/containerConfig.js";
import { register as registerClone } from "./tools/write/clone.js";
import { register as registerMigrate } from "./tools/write/migrate.js";
import { register as registerVmExec } from "./tools/write/vmExec.js";
import { register as registerContainerExec } from "./tools/write/containerExec.js";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "clustr", version: "0.1.0" });

  // Endpoint management registers FIRST, on the unpatched server, so these tools
  // have no injected `host` and work even with zero endpoints configured (you
  // need them to add the first one).
  registerEndpoints(server);
  // Onboarding also registers here: its `host` is a raw IP (not an endpoint
  // name), and it must work before any endpoint exists.
  registerSetup(server);

  // From here on, every tool gets an optional `host` and routes to that endpoint.
  patchForMultiHost(server);

  // Read
  registerNodes(server);
  registerVms(server);
  registerContainers(server);
  registerStorage(server);
  registerUpdates(server);
  registerBackupsList(server);
  registerStorageContent(server);
  registerTasks(server);
  registerBackupJobs(server);
  registerApt(server);
  registerMetrics(server);
  registerPools(server);
  registerNetwork(server);
  registerCluster(server);
  registerReview(server);
  // Slash-menu prompts (/clustr)
  registerPrompts(server);
  // Write
  registerDownloads(server);
  registerVmPower(server);
  registerContainerPower(server);
  registerVmSnapshots(server);
  registerContainerSnapshots(server);
  registerVmDelete(server);
  registerContainerDelete(server);
  registerVmCreate(server);
  registerContainerCreate(server);
  registerVmBackup(server);
  registerContainerBackup(server);
  registerVmRestore(server);
  registerContainerRestore(server);
  registerVmConfig(server);
  registerContainerConfig(server);
  registerClone(server);
  registerMigrate(server);
  registerVmExec(server);
  registerContainerExec(server);
  return server;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const httpMode =
    args.includes("--http") ||
    /^(http|streamable-http)$/i.test(process.env.CLUSTR_TRANSPORT ?? "");

  if (httpMode) {
    // Loaded lazily so the stdio/desktop path never pulls in Express.
    const { runHttp } = await import("./http.js");
    const portArg = args[args.indexOf("--port") + 1];
    const password = process.env.CLUSTR_AUTH_PASSWORD?.trim() || "";
    await runHttp(buildServer, {
      host: process.env.CLUSTR_HTTP_HOST?.trim() || "127.0.0.1",
      port: Number.parseInt(portArg || process.env.CLUSTR_HTTP_PORT || "8080", 10),
      allowUnauthenticated: /^(1|true|yes|on)$/i.test(
        process.env.CLUSTR_ALLOW_UNAUTHENTICATED ?? "",
      ),
      allowedHosts: (process.env.CLUSTR_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean),
      auth: password
        ? { username: process.env.CLUSTR_AUTH_USERNAME?.trim() || "admin", password }
        : null,
      publicUrl: process.env.CLUSTR_PUBLIC_URL?.trim() || "",
    });
    return; // HTTP server keeps the process alive
  }

  // Default: stdio (the desktop extension model).
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("Clustr failed to start:", err);
  process.exit(1);
});
