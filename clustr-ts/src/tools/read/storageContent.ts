/**
 * Read-only tools for enumerating what's *on* a storage — ISOs, container
 * templates, disk images, snippets — not just its capacity. These close the
 * loop with create_vm (needs an ISO path) and create_container (needs a template
 * path): now those paths can be discovered, not guessed.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxmoxGet } from "../../proxmox.js";
import { gb, safe } from "../../safe.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

interface ContentRow {
  volid?: string;
  content?: string;
  format?: string;
  size?: number;
  ctime?: number;
  vmid?: number | string;
}

const CONTENT_TYPES = [
  "iso",
  "vztmpl",
  "backup",
  "images",
  "rootdir",
  "snippets",
] as const;

/**
 * Fetch content of a given type from one storage, or — when no storage is
 * given — from every storage on the node that advertises that content type.
 */
async function contentFor(
  node: string,
  contentType: string,
  storage?: string,
): Promise<{ storage: string; rows: ContentRow[] }[]> {
  let storages: string[];
  if (storage) {
    storages = [storage];
  } else {
    const list = (await proxmoxGet(`/nodes/${node}/storage`, {
      content: contentType,
    })) as { storage?: string }[];
    storages = list.map((s) => String(s.storage)).filter(Boolean);
  }

  const out: { storage: string; rows: ContentRow[] }[] = [];
  for (const s of storages) {
    const rows = (await proxmoxGet(`/nodes/${node}/storage/${s}/content`, {
      content: contentType,
    })) as ContentRow[];
    if (rows.length) out.push({ storage: s, rows });
  }
  return out;
}

function shortName(volid: string): string {
  // local:vztmpl/debian-12-standard_amd64.tar.zst -> debian-12-standard_amd64...
  const tail = volid.split("/").slice(1).join("/");
  return tail || volid;
}

function renderGroups(
  groups: { storage: string; rows: ContentRow[] }[],
  emptyMsg: string,
  withSize = true,
): string {
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  if (!total) return emptyMsg;
  const lines: string[] = [];
  for (const g of groups) {
    lines.push(`### ${g.storage}`);
    for (const r of g.rows) {
      const size = withSize && r.size ? `  (${gb(r.size)} GB)` : "";
      lines.push(`- \`${r.volid}\`${size}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function register(server: McpServer): void {
  server.registerTool(
    "list_templates",
    {
      title: "List Container Templates",
      description:
        "List LXC container templates (vztmpl) available on a node's storage. " +
        "Use a returned volume id as the ostemplate for create_container. Omit " +
        "storage to search all template-enabled storages on the node.",
      inputSchema: {
        node: z.string().describe("Node name (e.g. 'pve')"),
        storage: z
          .string()
          .optional()
          .describe("Optional: limit to one storage"),
      },
      annotations: READ,
    },
    async ({ node, storage }) =>
      safe("list_templates", async () => {
        const groups = await contentFor(node, "vztmpl", storage);
        return (
          "## Container templates\n\n" +
          renderGroups(
            groups,
            "No container templates found. Download one in the Proxmox UI (CT templates) or with `pveam`.",
          )
        );
      }),
  );

  server.registerTool(
    "list_isos",
    {
      title: "List ISO Images",
      description:
        "List ISO images available on a node's storage. Use a returned volume " +
        "id as the iso_path for create_vm. Omit storage to search all " +
        "ISO-enabled storages on the node.",
      inputSchema: {
        node: z.string().describe("Node name (e.g. 'pve')"),
        storage: z
          .string()
          .optional()
          .describe("Optional: limit to one storage"),
      },
      annotations: READ,
    },
    async ({ node, storage }) =>
      safe("list_isos", async () => {
        const groups = await contentFor(node, "iso", storage);
        return (
          "## ISO images\n\n" +
          renderGroups(groups, "No ISO images found.")
        );
      }),
  );

  server.registerTool(
    "list_storage_content",
    {
      title: "List Storage Content",
      description:
        "List the contents of a storage pool: ISOs, container templates (vztmpl), " +
        "VM disk images, backups, snippets. Filter by content type, or omit it to " +
        "see everything.",
      inputSchema: {
        node: z.string().describe("Node name (e.g. 'pve')"),
        storage: z.string().describe("Storage name (e.g. 'local')"),
        content_type: z
          .enum(CONTENT_TYPES)
          .optional()
          .describe("Optional content type filter (iso, vztmpl, backup, images, …)"),
      },
      annotations: READ,
    },
    async ({ node, storage, content_type }) =>
      safe("list_storage_content", async () => {
        const query = content_type ? { content: content_type } : undefined;
        const rows = (await proxmoxGet(
          `/nodes/${node}/storage/${storage}/content`,
          query,
        )) as ContentRow[];
        if (!rows.length) {
          return `No content found on '${storage}'${
            content_type ? ` of type ${content_type}` : ""
          }.`;
        }
        rows.sort((a, b) =>
          String(a.content).localeCompare(String(b.content)) ||
          String(a.volid).localeCompare(String(b.volid)),
        );
        const lines = [`## Content on ${storage} (${rows.length})\n`];
        for (const r of rows) {
          const size = r.size ? ` — ${gb(r.size)} GB` : "";
          const owner = r.vmid ? ` — VM ${r.vmid}` : "";
          lines.push(
            `- [${r.content}] \`${r.volid}\`${size}${owner}` +
              (r.volid ? `\n   ${shortName(String(r.volid))}` : ""),
          );
        }
        return lines.join("\n");
      }),
  );
}
