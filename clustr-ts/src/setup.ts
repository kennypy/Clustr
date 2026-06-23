/**
 * Onboarding helpers for the `setup_clustr` tool — pure and unit-tested.
 *
 * Goal: turn "here's my Proxmox host IP" into a correctly-scoped API token with
 * the least fuss. Proxmox's web UI can't pre-fill an API-token's privileges from
 * a link, so the reliable "permissions it needs" path is a single copy-paste
 * `pveum` snippet (run in the node shell) that creates the role + token + ACL
 * and prints the secret. These functions build that snippet, the login URL, and
 * the paste-back instructions; the tool layer wires them to Claude (and can also
 * provision the token automatically over the API given a one-time admin login).
 */

/** The least-privilege role Clustr's *management* tools need. Curated to cover
 *  every write tool — power, config, snapshots, backup/restore, clone, migrate,
 *  downloads, plus VM.Monitor (guest-agent exec) and VM.Console (LXC console
 *  exec) — without granting blanket admin. Read-only setups use PVEAuditor. */
export const CLUSTR_PRIVS: readonly string[] = [
  "Datastore.Audit",
  "Datastore.AllocateSpace",
  "Datastore.AllocateTemplate",
  "Pool.Audit",
  "Sys.Audit",
  "VM.Audit",
  "VM.PowerMgmt",
  "VM.Console",
  "VM.Monitor",
  "VM.Config.Disk",
  "VM.Config.CPU",
  "VM.Config.Memory",
  "VM.Config.Network",
  "VM.Config.Options",
  "VM.Config.HWType",
  "VM.Config.Cloudinit",
  "VM.Config.CDROM",
  "VM.Backup",
  "VM.Snapshot",
  "VM.Snapshot.Rollback",
  "VM.Allocate",
  "VM.Clone",
  "VM.Migrate",
];

export const CLUSTR_ROLE = "Clustr";
export const READONLY_ROLE = "PVEAuditor";
export const DEFAULT_SETUP_USER = "clustr@pve";
export const DEFAULT_TOKEN_NAME = "clustr";

export type SetupMode = "full" | "readonly";

/** Space-separated privilege list for the `pveum role` CLI. */
export function privsForCli(): string {
  return CLUSTR_PRIVS.join(" ");
}

/** Comma-separated privilege list for the `POST /access/roles` API. */
export function privsForApi(): string {
  return CLUSTR_PRIVS.join(",");
}

/** Accept an IP, hostname, `host:port`, or full `https://host:port/...` URL and
 *  return a clean host + API port (defaulting to 8006).
 *
 *  Security: the result is interpolated into `https://${host}:${port}/...` for a
 *  request that, on the automated path, carries a Proxmox **admin password**. So
 *  this rejects anything that could redirect that request elsewhere — userinfo
 *  (`user:pass@host`), an embedded scheme, path, query, or fragment — and locks
 *  the host to a bare hostname / IPv4 / bracketed IPv6, mirroring the validation
 *  `endpoints.normalize()` applies to persisted endpoints. Without this, a host
 *  like `root:pw@evil.com` would POST the admin password to `evil.com`. */
export function parseHostInput(raw: string): { host: string; port: number } {
  let s = (raw ?? "").trim();
  if (!s) throw new Error("A Proxmox host IP or hostname is required.");
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ""); // strip a leading scheme
  s = s.replace(/[/?#].*$/, ""); // strip any path, query, or fragment
  let host = s;
  let port = 8006;

  const v6 = s.match(/^\[([0-9A-Fa-f:]+)\](?::(\d+))?$/); // [2001:db8::1]:8006
  if (v6) {
    host = v6[1];
    if (v6[2]) port = Number.parseInt(v6[2], 10);
  } else {
    const idx = s.lastIndexOf(":");
    if (idx > -1 && /^\d+$/.test(s.slice(idx + 1))) {
      host = s.slice(0, idx);
      port = Number.parseInt(s.slice(idx + 1), 10);
    }
    // Bare hostname or IPv4 only — nothing that can carry credentials (`@`), a
    // port we didn't parse, or any other URL machinery.
    if (!/^[A-Za-z0-9.-]+$/.test(host)) {
      throw new Error(
        `Invalid Proxmox host '${host}': use a bare hostname, IPv4, or [IPv6] — ` +
          "no scheme, path, credentials ('@'), or embedded port.",
      );
    }
  }
  if (!host) throw new Error(`Could not parse a host from '${raw}'.`);
  if (!Number.isFinite(port) || port < 1 || port > 65535) port = 8006;
  return { host, port };
}

/** The browser URL for the Proxmox web UI (login lands here). */
export function proxmoxWebUrl(host: string, port: number): string {
  return `https://${host}:${port === 8006 ? 8006 : port}/`;
}

export interface SnippetOptions {
  mode: SetupMode;
  user: string;
  tokenName: string;
}

/**
 * A single copy-paste shell snippet for the Proxmox node shell that creates a
 * dedicated user + API token with exactly the privileges Clustr needs and prints
 * the secret. Idempotent-ish: re-running updates the role and is safe if the
 * user already exists (adding an existing *token* still errors — by design, so
 * you don't silently clobber one).
 */
export function buildProvisionScript(o: SnippetOptions): string {
  const role = o.mode === "full" ? CLUSTR_ROLE : READONLY_ROLE;
  const lines: string[] = [];
  if (o.mode === "full") {
    lines.push(
      `pveum role add ${CLUSTR_ROLE} --privs "${privsForCli()}" \\`,
      `  || pveum role modify ${CLUSTR_ROLE} --privs "${privsForCli()}"`,
    );
  }
  lines.push(
    `pveum user add ${o.user} --comment "Clustr MCP" 2>/dev/null || true`,
    `pveum user token add ${o.user} ${o.tokenName} --privsep 0 --comment "Clustr MCP"`,
    `pveum acl modify / --users ${o.user} --roles ${role}`,
  );
  return lines.join("\n");
}

/** The full guided onboarding message (link + snippet + paste-back values). */
export function formatGuide(args: {
  host: string;
  port: number;
  mode: SetupMode;
  user: string;
  tokenName: string;
}): string {
  const { host, port, mode, user, tokenName } = args;
  const url = proxmoxWebUrl(host, port);
  const script = buildProvisionScript({ mode, user, tokenName });
  const roleLabel =
    mode === "full"
      ? `a dedicated **${CLUSTR_ROLE}** role (least-privilege management)`
      : `the built-in **${READONLY_ROLE}** role (read-only)`;

  return [
    `## Set up Clustr for ${host}\n`,
    `This creates an API token scoped to ${roleLabel}, so Clustr can do its job ` +
      "without handing it your root credentials.\n",
    `**1. Open your Proxmox web UI:** ${url}`,
    "   Log in as `root` (or any admin).\n",
    "**2. Open a node shell** — in the UI: *Datacenter → your node → ›_ Shell* " +
      "(or SSH to the node as root) — and paste this:\n",
    "```bash",
    script,
    "```\n",
    "The last command prints a table with a **`value`** field — that's your token " +
      "secret, shown **once**. Copy it.\n",
    "**3. Give the values back to Clustr** to finish setup:",
    `   - **Host:** \`${host}\`${port === 8006 ? "" : `   **Port:** \`${port}\``}`,
    `   - **User:** \`${user}\``,
    `   - **Token name:** \`${tokenName}\``,
    "   - **Token secret:** the `value` you copied",
    "",
    "Paste those into the Clustr extension's settings form, **or** just tell me " +
      'the secret and say "add this endpoint" and I\'ll wire it up with ' +
      "`add_endpoint`.\n",
    "_Tip: prefer read-only? Re-run setup with `mode: readonly`. Want me to create " +
      "the token for you instead of pasting a snippet? Re-run with your Proxmox " +
      "`admin_user` + `admin_password` and I'll provision it over the API (the " +
      "password is used once and never stored)._",
  ].join("\n");
}

/** Build the `user!tokenname` id Proxmox uses for a token. */
export function tokenId(user: string, tokenName: string): string {
  return `${user}!${tokenName}`;
}
