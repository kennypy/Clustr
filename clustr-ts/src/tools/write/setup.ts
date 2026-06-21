/**
 * setup_clustr — streamlined onboarding.
 *
 * Two paths, one tool:
 *  - Guided (default): given a host IP, returns the Proxmox login URL plus a
 *    one-paste `pveum` snippet that creates a correctly-scoped token and prints
 *    the secret to copy back. Reliable and credential-free.
 *  - Automated: given a one-time Proxmox admin login (admin_user + admin_password),
 *    Clustr provisions the role + user + token + ACL over the API and hands the
 *    token back. Gated behind confirm=true; the password is used once, never
 *    stored, and never echoed.
 *
 * Registered before the multi-host patch so its `host` argument is a raw IP/
 * hostname (not a configured-endpoint name) and it works with zero endpoints
 * configured — you need it precisely when nothing is set up yet.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Agent, fetch } from "undici";

import { addEndpoint } from "../../endpoints.js";
import { safe } from "../../safe.js";
import {
  CLUSTR_ROLE,
  DEFAULT_SETUP_USER,
  DEFAULT_TOKEN_NAME,
  READONLY_ROLE,
  formatGuide,
  parseHostInput,
  privsForApi,
  proxmoxWebUrl,
  tokenId,
  type SetupMode,
} from "../../setup.js";

const WRITE = { readOnlyHint: false, destructiveHint: false } as const;

// ---- standalone Proxmox client (no configured endpoint exists yet) ----------

interface Conn {
  base: string;
  dispatcher?: Agent;
}

function connFor(host: string, port: number, verifySsl: boolean): Conn {
  return {
    base: `https://${host}:${port}/api2/json`,
    dispatcher: verifySsl
      ? undefined
      : new Agent({ connect: { rejectUnauthorized: false } }),
  };
}

interface Ticket {
  cookie: string;
  csrf: string;
}

async function getTicket(
  c: Conn,
  username: string,
  password: string,
): Promise<Ticket> {
  const form = new URLSearchParams({ username, password });
  let resp;
  try {
    resp = await fetch(`${c.base}/access/ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      dispatcher: c.dispatcher,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach Proxmox at ${c.base} — ${msg}`);
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Login failed (${resp.status}). Check the admin user/password and realm ` +
        `(e.g. root@pam). ${body.slice(0, 200)}`,
    );
  }
  const data = ((await resp.json()) as { data?: any })?.data ?? {};
  if (!data.ticket || !data.CSRFPreventionToken) {
    throw new Error("Proxmox did not return a login ticket.");
  }
  return { cookie: `PVEAuthCookie=${data.ticket}`, csrf: data.CSRFPreventionToken };
}

async function pv(
  c: Conn,
  t: Ticket,
  method: "POST" | "PUT",
  path: string,
  body: Record<string, string | number>,
): Promise<{ ok: boolean; status: number; data: any; text: string }> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) form.set(k, String(v));
  const resp = await fetch(`${c.base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: t.cookie,
      CSRFPreventionToken: t.csrf,
    },
    body: form.toString(),
    dispatcher: c.dispatcher,
  });
  const text = await resp.text();
  let data: any = null;
  try {
    data = JSON.parse(text)?.data ?? null;
  } catch {
    /* non-JSON error body */
  }
  return { ok: resp.ok, status: resp.status, data, text };
}

async function tokenWorks(
  c: Conn,
  user: string,
  tokenName: string,
  value: string,
): Promise<boolean> {
  try {
    const resp = await fetch(`${c.base}/version`, {
      headers: { Authorization: `PVEAPIToken=${tokenId(user, tokenName)}=${value}` },
      dispatcher: c.dispatcher,
    });
    return resp.ok;
  } catch {
    return false;
  }
}

interface ProvisionResult {
  value: string;
  role: string;
  verified: boolean;
}

async function provision(args: {
  host: string;
  port: number;
  verifySsl: boolean;
  adminUser: string;
  adminPassword: string;
  user: string;
  tokenName: string;
  mode: SetupMode;
}): Promise<ProvisionResult> {
  const c = connFor(args.host, args.port, args.verifySsl);
  const t = await getTicket(c, args.adminUser, args.adminPassword);
  const role = args.mode === "full" ? CLUSTR_ROLE : READONLY_ROLE;

  // 1. Role (full mode only — readonly reuses the built-in PVEAuditor).
  if (args.mode === "full") {
    const add = await pv(c, t, "POST", "/access/roles", {
      roleid: CLUSTR_ROLE,
      privs: privsForApi(),
    });
    if (!add.ok) {
      const upd = await pv(c, t, "PUT", `/access/roles/${CLUSTR_ROLE}`, {
        privs: privsForApi(),
      });
      if (!upd.ok) {
        throw new Error(
          `Could not create or update the ${CLUSTR_ROLE} role (${upd.status}). ${upd.text.slice(0, 200)}`,
        );
      }
    }
  }

  // 2. User (ignore "already exists").
  const userAdd = await pv(c, t, "POST", "/access/users", { userid: args.user });
  if (!userAdd.ok && !/already exists/i.test(userAdd.text)) {
    // Non-fatal unless the next step fails; many setups pre-create the user.
  }

  // 3. Token — the secret is returned exactly once.
  const tok = await pv(
    c,
    t,
    "POST",
    `/access/users/${args.user}/token/${args.tokenName}`,
    { privsep: 0, comment: "Clustr MCP" },
  );
  if (!tok.ok) {
    if (/already exists/i.test(tok.text)) {
      throw new Error(
        `Token '${tokenId(args.user, args.tokenName)}' already exists, so its secret ` +
          "can't be re-shown. Re-run with a different `token_name`, or delete the old " +
          "token in Datacenter → Permissions → API Tokens.",
      );
    }
    throw new Error(`Could not create the API token (${tok.status}). ${tok.text.slice(0, 200)}`);
  }
  const value = tok.data?.value;
  if (!value) throw new Error("Proxmox created the token but returned no secret value.");

  // 4. ACL — grant the user (privsep=0 token inherits it) the role at '/'.
  const acl = await pv(c, t, "PUT", "/access/acl", {
    path: "/",
    users: args.user,
    roles: role,
    propagate: 1,
  });
  if (!acl.ok) {
    throw new Error(
      `Token created but granting it the ${role} role failed (${acl.status}). ${acl.text.slice(0, 200)}`,
    );
  }

  const verified = await tokenWorks(c, args.user, args.tokenName, value);
  return { value, role, verified };
}

export function register(server: McpServer): void {
  server.registerTool(
    "setup_clustr",
    {
      title: "Set Up Clustr (Get an API Token)",
      description:
        "Streamlined onboarding: turn a Proxmox host IP into a correctly-scoped API " +
        "token. With just `host`, returns the login URL plus a one-paste shell " +
        "snippet that creates the token with exactly the privileges Clustr needs, " +
        "then you copy the secret back. Optionally provide `admin_user` + " +
        "`admin_password` (with confirm=true) and Clustr provisions the token over " +
        "the API for you — the password is used once and never stored. Use " +
        "`mode: readonly` for a read-only (PVEAuditor) token.",
      inputSchema: {
        host: z
          .string()
          .describe("Proxmox host IP or hostname (e.g. 192.168.1.10). A URL is fine too."),
        mode: z
          .enum(["full", "readonly"])
          .default("full")
          .describe(
            "'full' = least-privilege management role; 'readonly' = PVEAuditor.",
          ),
        token_name: z
          .string()
          .default(DEFAULT_TOKEN_NAME)
          .describe("Name for the API token to create (default 'clustr')."),
        user: z
          .string()
          .default(DEFAULT_SETUP_USER)
          .describe("User to own the token (default 'clustr@pve', a PVE-realm user)."),
        admin_user: z
          .string()
          .optional()
          .describe(
            "Optional: a Proxmox admin login WITH realm (e.g. root@pam) to auto-create " +
              "the token over the API instead of pasting a snippet.",
          ),
        admin_password: z
          .string()
          .optional()
          .describe("Optional: that admin user's password. Used once, never stored."),
        verify_ssl: z
          .boolean()
          .default(false)
          .describe("Verify the host's TLS certificate (off for self-signed)."),
        add_as_endpoint: z
          .boolean()
          .default(true)
          .describe(
            "After auto-provisioning, register the new token as an endpoint in this " +
              "session so it's usable immediately.",
          ),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Required to actually provision over the API in the automated path. " +
              "Ignored by the guided (snippet) path.",
          ),
      },
      annotations: WRITE,
    },
    async (args) =>
      safe("setup_clustr", async () => {
        const { host, port } = parseHostInput(args.host);
        const mode = args.mode as SetupMode;
        const user = args.user?.trim() || DEFAULT_SETUP_USER;
        const tokenName = args.token_name?.trim() || DEFAULT_TOKEN_NAME;

        const wantsAuto = Boolean(args.admin_user && args.admin_password);
        if (!wantsAuto) {
          // Guided path — also nudges toward the automated option.
          return formatGuide({ host, port, mode, user, tokenName });
        }

        if (!args.confirm) {
          return (
            "🔎 **Review — nothing created yet.** With `confirm=true` I will log in " +
            `to **${host}:${port}** as \`${args.admin_user}\` (password used once, ` +
            "not stored) and create:\n" +
            (mode === "full"
              ? `- role **${CLUSTR_ROLE}** (least-privilege management)\n`
              : `- _(uses built-in **${READONLY_ROLE}**)_\n`) +
            `- user **${user}** + API token **${tokenName}**\n` +
            `- an ACL granting it the ${mode === "full" ? CLUSTR_ROLE : READONLY_ROLE} role at \`/\`\n\n` +
            "Re-run with the same arguments plus `confirm=true` to proceed."
          );
        }

        const res = await provision({
          host,
          port,
          verifySsl: args.verify_ssl,
          adminUser: args.admin_user as string,
          adminPassword: args.admin_password as string,
          user,
          tokenName,
          mode,
        });

        let endpointLine = "";
        if (args.add_as_endpoint) {
          try {
            const ep = addEndpoint({
              name: host,
              host,
              user,
              port,
              tokenName,
              tokenValue: res.value,
              verifySsl: args.verify_ssl,
            });
            endpointLine =
              `\n✅ Registered as endpoint **${ep.name}** for this session — try ` +
              `\`list_nodes\` (host: ${ep.name}). For the desktop extension, also paste ` +
              "the values below into the settings form so it persists across restarts.";
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            endpointLine = `\n⚠️ Could not auto-register the endpoint: ${msg}`;
          }
        }

        return [
          `✅ **Token created** on ${host}.${res.verified ? " Verified it works." : ""}`,
          res.verified ? "" : "\n⚠️ Created, but a test call didn't succeed yet — the ACL may take a moment.",
          "\n**Paste these into Clustr to finish setup:**",
          `- **Host:** \`${host}\`${port === 8006 ? "" : `   **Port:** \`${port}\``}`,
          `- **User:** \`${user}\``,
          `- **Token name:** \`${tokenName}\``,
          `- **Token secret:** \`${res.value}\``,
          `\n_Web UI: ${proxmoxWebUrl(host, port)} · Role granted: ${res.role}_`,
          endpointLine,
        ]
          .filter(Boolean)
          .join("\n");
      }),
  );
}
