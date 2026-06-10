/**
 * Proxmox API client — a thin typed wrapper over the Proxmox VE REST API.
 *
 * Authenticates with an API token (PVEAPIToken header). All non-2xx responses
 * are turned into ProxmoxError so the tool layer never leaks raw HTTP details.
 *
 * GET params go on the query string; POST/PUT bodies are form-encoded (what the
 * Proxmox API expects), matching the Python/proxmoxer behaviour — including the
 * use of literal hyphenated parameter names (e.g. "destroy-unreferenced-disks").
 */

import { Agent, fetch } from "undici";
import { getConfig } from "./config.js";

export class ProxmoxError extends Error {
  statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "ProxmoxError";
    this.statusCode = statusCode;
  }
}

// Built lazily; only used when TLS verification is disabled (self-signed certs).
let insecureDispatcher: Agent | null = null;

function dispatcher(): Agent | undefined {
  const cfg = getConfig();
  if (cfg.verifySsl) return undefined;
  if (!insecureDispatcher) {
    insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return insecureDispatcher;
}

function baseUrl(): string {
  const cfg = getConfig();
  return `https://${cfg.host}:${cfg.port}/api2/json`;
}

function authHeader(): string {
  const cfg = getConfig();
  return `PVEAPIToken=${cfg.user}!${cfg.tokenName}=${cfg.tokenValue}`;
}

type Params = Record<string, string | number | boolean | undefined | null>;

async function request(
  method: string,
  path: string,
  opts: { query?: Params; body?: Params } = {},
): Promise<unknown> {
  const url = new URL(baseUrl() + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = { Authorization: authHeader() };
  let body: string | undefined;
  if (opts.body) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.body)) {
      if (v !== undefined && v !== null) form.set(k, String(v));
    }
    body = form.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  let resp;
  try {
    resp = await fetch(url, { method, headers, body, dispatcher: dispatcher() });
  } catch (err) {
    const cfg = getConfig();
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProxmoxError(`Cannot reach Proxmox at ${cfg.host}:${cfg.port} — ${msg}`);
  }

  const textBody = await resp.text();
  if (!resp.ok) {
    throw new ProxmoxError(
      `Proxmox API error (${resp.status}): ${textBody || resp.statusText}`,
      resp.status,
    );
  }
  if (!textBody) return null;
  try {
    const json = JSON.parse(textBody) as { data?: unknown };
    return json?.data ?? json;
  } catch {
    return textBody;
  }
}

export function proxmoxGet(path: string, query?: Params): Promise<unknown> {
  return request("GET", path, { query });
}
export function proxmoxPost(path: string, body?: Params): Promise<unknown> {
  return request("POST", path, { body });
}
export function proxmoxDelete(path: string, query?: Params): Promise<unknown> {
  return request("DELETE", path, { query });
}
