/**
 * Proxmox API client — multi-endpoint.
 *
 * Which endpoint a call hits is carried in an AsyncLocalStorage set per tool
 * invocation (see runWithEndpoint), so the tool layer's proxmoxGet/Post/Put/
 * Delete keep their simple (path, body) signatures and don't need to thread a
 * host through every call. When nothing is set, the default endpoint is used —
 * which is the single-host case, unchanged.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { Agent, fetch } from "undici";

import {
  defaultEndpointName,
  endpointNames,
  getEndpoint,
  hasEndpoint,
  type Endpoint,
} from "./endpoints.js";

export class ProxmoxError extends Error {
  statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "ProxmoxError";
    this.statusCode = statusCode;
  }
}

// ---- endpoint routing ------------------------------------------------------
const als = new AsyncLocalStorage<string>();

/** Run `fn` with `name` as the active endpoint (validated). Undefined → default. */
export function runWithEndpoint<T>(name: string | undefined, fn: () => T): T {
  const resolved = name && name.trim() ? name.trim() : defaultEndpointName();
  if (!hasEndpoint(resolved)) {
    if (endpointNames().length === 0) {
      throw new ProxmoxError(
        "No Proxmox endpoint configured — add one with add_endpoint, or set " +
          "PROXMOX_HOST / PROXMOX_TOKEN_NAME / PROXMOX_TOKEN_VALUE.",
      );
    }
    throw new ProxmoxError(
      `Unknown Proxmox endpoint '${resolved}'. Use list_endpoints to see configured ones.`,
    );
  }
  return als.run(resolved, fn);
}

function currentEndpoint(): Endpoint {
  const name = als.getStore() ?? defaultEndpointName();
  const ep = getEndpoint(name);
  if (!ep) {
    throw new ProxmoxError(
      "No Proxmox endpoint configured. Set PROXMOX_HOST/TOKEN_* (single host) or CLUSTR_ENDPOINTS (multiple).",
    );
  }
  return ep;
}

// One undici dispatcher per endpoint that needs TLS verification disabled.
const dispatchers = new Map<string, Agent>();
function dispatcherFor(ep: Endpoint): Agent | undefined {
  if (ep.verifySsl) return undefined;
  let d = dispatchers.get(ep.name);
  if (!d) {
    d = new Agent({ connect: { rejectUnauthorized: false } });
    dispatchers.set(ep.name, d);
  }
  return d;
}

const baseUrl = (ep: Endpoint): string => `https://${ep.host}:${ep.port}/api2/json`;
const authHeader = (ep: Endpoint): string =>
  `PVEAPIToken=${ep.user}!${ep.tokenName}=${ep.tokenValue}`;

type Params = Record<string, string | number | boolean | undefined | null>;

async function request(
  method: string,
  path: string,
  opts: { query?: Params; body?: Params } = {},
): Promise<unknown> {
  const ep = currentEndpoint();
  const url = new URL(baseUrl(ep) + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = { Authorization: authHeader(ep) };
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
    resp = await fetch(url, { method, headers, body, dispatcher: dispatcherFor(ep) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProxmoxError(`Cannot reach Proxmox '${ep.name}' at ${ep.host}:${ep.port} — ${msg}`);
  }

  const textBody = await resp.text();
  if (!resp.ok) {
    throw new ProxmoxError(
      `Proxmox API error (${resp.status}) on '${ep.name}': ${textBody || resp.statusText}`,
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
export function proxmoxPut(path: string, body?: Params): Promise<unknown> {
  return request("PUT", path, { body });
}
export function proxmoxDelete(path: string, query?: Params): Promise<unknown> {
  return request("DELETE", path, { query });
}
