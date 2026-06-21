/**
 * Make every registered tool multi-host aware without editing 30 tool modules.
 *
 * Patches the server's registerTool so that:
 *   - an optional `host` input is added to every tool's schema, and
 *   - the tool body runs against that endpoint (or the default) via the
 *     AsyncLocalStorage routing in proxmox.ts.
 *
 * Tools keep calling proxmoxGet/Post/etc. exactly as before.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { runWithEndpoint } from "./proxmox.js";

/**
 * Identifier arguments that get interpolated into the API path as a single
 * segment (`/nodes/${node}/...`, `/pools/${poolid}`). Lock them to the Proxmox
 * identifier charset so a value like `pve/qemu/100/config` can't smuggle extra
 * path segments past `assertSafeApiPath` (which only blocks `..` and control
 * chars, not structural `/`). Numbers (vmid/ctid) are already safe via zod, and
 * UPIDs have their own parser. Centralised here so every tool is covered without
 * editing ~25 modules.
 */
const PATH_ID_FIELDS = ["node", "poolid"] as const;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function invalidPathIdentifier(args: Record<string, unknown>): string | null {
  for (const f of PATH_ID_FIELDS) {
    const v = args[f];
    if (typeof v === "string" && v.length > 0 && !SAFE_ID.test(v)) {
      return (
        `Invalid \`${f}\`: '${v}'. Proxmox ${f} names are letters, digits, dot, ` +
        "hyphen, underscore — no '/', spaces, or other characters."
      );
    }
  }
  return null;
}

const hostField = z
  .string()
  .optional()
  .describe(
    "Which configured Proxmox endpoint to target. Omit to use the default " +
      "endpoint. Only relevant when multiple endpoints are configured (see " +
      "list_endpoints).",
  );

export function patchForMultiHost(server: McpServer): void {
  // Always inject `host` (optional) so endpoints added at runtime are targetable
  // without restarting. Single-host setups simply never pass it — it resolves to
  // the sole/default endpoint.
  const original = server.registerTool.bind(server) as (
    name: string,
    config: Record<string, any>,
    cb: (args: any, extra: any) => unknown,
  ) => unknown;

  (server as unknown as { registerTool: unknown }).registerTool = (
    name: string,
    config: Record<string, any>,
    cb: (args: any, extra: any) => unknown,
  ) => {
    const inputSchema = { ...(config.inputSchema ?? {}), host: hostField };
    return original(name, { ...config, inputSchema }, (args: any, extra: any) => {
      const host = args?.host as string | undefined;
      const rest = args ? { ...args } : {};
      delete (rest as Record<string, unknown>).host;
      const bad = invalidPathIdentifier(rest as Record<string, unknown>);
      if (bad) {
        return { content: [{ type: "text", text: `Refusing request: ${bad}` }] };
      }
      return runWithEndpoint(host, () => cb(rest, extra));
    });
  };
}
