/**
 * Fetch templates and ISOs onto storage, so Claude can get what create needs,
 * instead of telling you to download it by hand.
 *
 *   list_available_templates → the appliance index (pveam) of downloadable CT
 *                              templates (read).
 *   download_template        → pull one of those onto a storage (write).
 *   download_from_url        → fetch an ISO or template from any URL (write).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ProxmoxError, proxmoxGet, proxmoxPost } from "../../proxmox.js";
import { safe } from "../../safe.js";
import { atLeast, getProxmoxVersion } from "../../version.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;
const WRITE = { readOnlyHint: false, destructiveHint: false } as const;

/**
 * Reduce a requested/derived download filename to a single safe path segment:
 * strip any directory parts and traversal so it can't point outside the target
 * storage (Proxmox validates too; this is defense-in-depth). Exported for tests.
 */
export function sanitizeDownloadName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._+-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "");
  return cleaned || "download";
}

interface ApiTemplate {
  template?: string;
  os?: string;
  version?: string;
  headline?: string;
  section?: string;
}

export function register(server: McpServer): void {
  server.registerTool(
    "list_available_templates",
    {
      title: "List Downloadable Templates",
      description:
        "List LXC container templates available to download from the Proxmox " +
        "appliance index (pveam). Use 'search' to narrow (e.g. 'debian', " +
        "'ubuntu'); the full list is long. Pass a returned 'template' name to " +
        "download_template.",
      inputSchema: {
        node: z.string().describe("Node name (e.g. 'pve')"),
        search: z
          .string()
          .optional()
          .describe("Filter by name/OS/headline, e.g. 'debian'"),
      },
      annotations: READ,
    },
    async ({ node, search }) =>
      safe("list_available_templates", async () => {
        let rows = (await proxmoxGet(`/nodes/${node}/aplinfo`)) as ApiTemplate[];
        if (search) {
          const q = search.toLowerCase();
          rows = rows.filter((r) =>
            `${r.template} ${r.os} ${r.headline}`.toLowerCase().includes(q),
          );
        }
        if (!rows.length) {
          return `No downloadable templates${search ? ` matching '${search}'` : ""} found.`;
        }
        const capped = rows.slice(0, 60);
        const lines = [
          `## Downloadable templates (${rows.length}${
            rows.length > capped.length ? `, showing ${capped.length}` : ""
          })\n`,
        ];
        for (const r of capped) {
          lines.push(`- \`${r.template}\` - ${r.headline ?? r.os ?? ""}`);
        }
        if (rows.length > capped.length) {
          lines.push("\nNarrow with `search` to see more.");
        }
        lines.push("\nDownload one with `download_template` (node, storage, template).");
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "download_template",
    {
      title: "Download Container Template",
      description:
        "Download an LXC template from the appliance index onto a storage. " +
        "'template' is a name from list_available_templates; 'storage' must " +
        "accept container templates (e.g. 'local').",
      inputSchema: {
        node: z.string().describe("Node name"),
        storage: z.string().describe("Target storage for the template (e.g. 'local')"),
        template: z
          .string()
          .describe("Template name from list_available_templates"),
      },
      annotations: WRITE,
    },
    async ({ node, storage, template }) =>
      safe("download_template", async () => {
        const task = await proxmoxPost(`/nodes/${node}/aplinfo`, {
          storage,
          template,
        });
        return (
          `✅ Downloading template **${template}** to **${storage}** on ${node}.\n` +
          `Task ID: \`${String(task)}\`\n\n` +
          "Follow with `get_task_status`; then it'll appear in `list_templates`."
        );
      }),
  );

  server.registerTool(
    "download_from_url",
    {
      title: "Download ISO/Template from URL",
      description:
        "Download a file from a URL directly onto a storage, typically an ISO " +
        "(content=iso) or a container template (content=vztmpl). The storage " +
        "must accept that content type. Needs a token with `Sys.AccessNetwork` " +
        "on the node (PVE 8.2+) or, on older nodes, `Sys.Modify`; the Clustr " +
        "role grants Sys.AccessNetwork, so a token made on PVE 8.0/8.1 will 403 " +
        "here until the node is upgraded or granted Sys.Modify.",
      inputSchema: {
        node: z.string().describe("Node name"),
        storage: z.string().describe("Target storage (e.g. 'local')"),
        url: z.string().url().describe("Direct download URL"),
        content: z
          .enum(["iso", "vztmpl"])
          .describe("What kind of file: 'iso' or 'vztmpl' (container template)"),
        filename: z
          .string()
          .optional()
          .describe("Filename to save as. Default: derived from the URL."),
      },
      annotations: WRITE,
    },
    async ({ node, storage, url, content, filename }) =>
      safe("download_from_url", async () => {
        const name = sanitizeDownloadName(filename || url.split("/").pop() || "download");
        let task: unknown;
        try {
          task = await proxmoxPost(
            `/nodes/${node}/storage/${storage}/download-url`,
            { url, content, filename: name },
          );
        } catch (err) {
          // The common failure here is a privilege 403: /download-url needs
          // Sys.AccessNetwork (PVE 8.2+) or Sys.Modify (older). Detect the node's
          // version so the message is specific instead of a bare 403.
          if (err instanceof ProxmoxError && err.statusCode === 403) {
            const ver = await getProxmoxVersion();
            if (ver && !atLeast(ver, 8, 2)) {
              throw new ProxmoxError(
                `Download denied (403) and node '${node}' is Proxmox ${ver.version}. The ` +
                  "/download-url endpoint needs `Sys.AccessNetwork`, which only exists on PVE " +
                  "8.2+; on this version the token needs `Sys.Modify` on `/` instead. Grant " +
                  "Sys.Modify to the Clustr role, or upgrade the node to 8.2+ (where the " +
                  "narrower Sys.AccessNetwork the Clustr role already grants applies).",
              );
            }
            throw new ProxmoxError(
              `Download denied (403). The token needs \`Sys.AccessNetwork\` on the node ` +
                "(PVE 8.2+) or `Sys.Modify` on older nodes, plus `Datastore.AllocateTemplate` " +
                "on the target storage." +
                (ver ? ` Node version: ${ver.version}.` : ""),
            );
          }
          throw err;
        }
        return (
          `✅ Downloading **${name}** (${content}) from URL to **${storage}** on ${node}.\n` +
          `Task ID: \`${String(task)}\`\n\nFollow with \`get_task_status\`.`
        );
      }),
  );
}
