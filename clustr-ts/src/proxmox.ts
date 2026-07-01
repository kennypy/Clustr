/**
 * Proxmox API client: multi-endpoint.
 *
 * Which endpoint a call hits is carried in an AsyncLocalStorage set per tool
 * invocation (see runWithEndpoint), so the tool layer's proxmoxGet/Post/Put/
 * Delete keep their simple (path, body) signatures and don't need to thread a
 * host through every call. When nothing is set, the default endpoint is used,
 * which is the single-host case, unchanged.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { Agent, fetch, WebSocket } from "undici";

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
        "No Proxmox endpoint configured yet. Run `setup_clustr` with your host IP to " +
          "create an API token (it'll walk you through it), add one with `add_endpoint`, " +
          "or set PROXMOX_HOST / PROXMOX_TOKEN_NAME / PROXMOX_TOKEN_VALUE.",
      );
    }
    throw new ProxmoxError(
      `Unknown Proxmox endpoint '${resolved}'. Use list_endpoints to see configured ones.`,
    );
  }
  return als.run(resolved, fn);
}

// Endpoints we've already warned about running with TLS verification off, so the
// warning is loud but fires once per endpoint rather than on every request.
const warnedInsecureTls = new Set<string>();

function currentEndpoint(): Endpoint {
  const name = als.getStore() ?? defaultEndpointName();
  const ep = getEndpoint(name);
  if (!ep) {
    throw new ProxmoxError(
      "No Proxmox endpoint configured. Set PROXMOX_HOST/TOKEN_* (single host) or CLUSTR_ENDPOINTS (multiple).",
    );
  }
  if (!ep.verifySsl && !warnedInsecureTls.has(ep.name)) {
    warnedInsecureTls.add(ep.name);
    // stderr, not stdout: stdout is the MCP stdio protocol channel.
    console.error(
      `WARNING: TLS verification is OFF for Proxmox endpoint '${ep.name}' (${ep.host}). ` +
        "The API token is sent over an unverified connection and can be captured by a " +
        "man-in-the-middle on the network path. Once the host has a trusted (or pinned) " +
        "certificate, set verifySsl=true (or PROXMOX_VERIFY_SSL=true) for this endpoint.",
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

/**
 * Reject API paths that try to escape the intended endpoint via traversal or
 * control characters. Tool-supplied identifiers (node names, storage, etc.) are
 * interpolated into `path`; a `..` segment would let `new URL()` normalise the
 * request onto a different API path. Same-host and token-scoped, so impact is
 * low, but cheap to close centrally. Exported pure for tests.
 */
export function assertSafeApiPath(path: string): void {
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) {
      throw new ProxmoxError("Refusing request: control character in API path.");
    }
  }
  if (path.split(/[/\\]/).some((seg) => seg === "..")) {
    throw new ProxmoxError("Refusing request: path traversal segment in API path.");
  }
}

type Scalar = string | number | boolean | undefined | null;
type Params = Record<string, Scalar | Scalar[]>;

async function request(
  method: string,
  path: string,
  opts: { query?: Params; body?: Params } = {},
): Promise<unknown> {
  assertSafeApiPath(path);
  const ep = currentEndpoint();
  const url = new URL(baseUrl(ep) + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && !Array.isArray(v)) {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers: Record<string, string> = { Authorization: authHeader(ep) };
  let body: string | undefined;
  if (opts.body) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.body)) {
      // Array values are repeated keys: that's how the Proxmox API receives
      // array-typed parameters (e.g. the guest-agent `command` argv list).
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item !== undefined && item !== null) form.append(k, String(item));
        }
      } else if (v !== undefined && v !== null) {
        form.set(k, String(v));
      }
    }
    body = form.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  let resp;
  try {
    resp = await fetch(url, { method, headers, body, dispatcher: dispatcherFor(ep) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProxmoxError(`Cannot reach Proxmox '${ep.name}' at ${ep.host}:${ep.port}: ${msg}`);
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

/**
 * Open an authenticated WebSocket to the active endpoint.
 *
 * Used by the LXC console exec path (termproxy + vncwebsocket): Proxmox exposes
 * no REST `exec` for containers, so running a command means driving the console
 * terminal over a websocket. The connection inherits the endpoint's host, port,
 * API-token Authorization header, and TLS-verification setting, so callers stay
 * out of the auth/transport details, same as the proxmoxGet/Post helpers.
 */
export function openProxmoxWebsocket(path: string, query?: Params): WebSocket {
  assertSafeApiPath(path);
  const ep = currentEndpoint();
  const url = new URL(`wss://${ep.host}:${ep.port}/api2/json${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && !Array.isArray(v)) {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return new WebSocket(url, {
    headers: { Authorization: authHeader(ep) },
    dispatcher: dispatcherFor(ep),
  });
}
