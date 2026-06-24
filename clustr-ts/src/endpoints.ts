/**
 * Endpoint registry: Clustr can manage several Proxmox clusters from one
 * instance. Endpoints come from (in priority order):
 *   1. CLUSTR_ENDPOINTS         - a JSON array of endpoint objects
 *   2. CLUSTR_ENDPOINTS_FILE    - a writable JSON file (also where add/remove
 *                                 persist), so endpoints can be managed at runtime
 *   3. PROXMOX_* env            - the single-endpoint shortcut (named "default"),
 *                                 so existing single-host setups keep working
 *                                 unchanged.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Endpoint {
  name: string;
  host: string;
  port: number;
  user: string;
  tokenName: string;
  tokenValue: string;
  verifySsl: boolean;
}

function asBool(v: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(v ?? "").trim());
}

const hasControlChars = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
};

/**
 * Validate + coerce an endpoint. The host is interpolated raw into
 * `https://${host}:${port}/...` and the token fields into the `Authorization`
 * header, so unvalidated input here is a token-exfiltration / SSRF / header-
 * injection primitive: a host like `attacker.com/` or `a@evil.com` makes
 * `new URL()` resolve to a different host and the API token rides along. Lock
 * the host to a bare hostname / IPv4 / [IPv6], and reject control chars in the
 * header-bound fields. Exported for tests.
 */
export function normalize(e: Record<string, any>): Endpoint {
  if (!e.name || !e.host || !e.tokenName || !e.tokenValue) {
    throw new Error(
      "Each endpoint needs name, host, tokenName, tokenValue (user/port/verifySsl optional).",
    );
  }
  const host = String(e.host).trim();
  // Bare hostname / IPv4, or a bracketed IPv6 literal. Nothing that could carry
  // a scheme, path, userinfo (`@`), query/fragment, or an embedded port.
  if (!/^[A-Za-z0-9.-]+$/.test(host) && !/^\[[0-9A-Fa-f:]+\]$/.test(host)) {
    throw new Error(
      `Invalid endpoint host '${host}': use a bare hostname, IPv4, or [IPv6], ` +
        "no scheme, path, '@', or embedded port.",
    );
  }
  const port = Number(e.port ?? 8006);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid endpoint port '${String(e.port)}': must be an integer 1–65535.`);
  }
  const name = String(e.name);
  const user = String(e.user ?? "root@pam");
  const tokenName = String(e.tokenName);
  const tokenValue = String(e.tokenValue);
  for (const [field, val] of [
    ["name", name],
    ["user", user],
    ["tokenName", tokenName],
    ["tokenValue", tokenValue],
  ] as const) {
    if (hasControlChars(val)) {
      throw new Error(`Endpoint ${field} contains control characters.`);
    }
  }
  return { name, host, port, user, tokenName, tokenValue, verifySsl: asBool(e.verifySsl) };
}

function singleFromEnv(): Endpoint | null {
  const host = process.env.PROXMOX_HOST;
  const tokenName = process.env.PROXMOX_TOKEN_NAME;
  const tokenValue = process.env.PROXMOX_TOKEN_VALUE;
  if (!host || !tokenName || !tokenValue) return null;
  return {
    name: "default",
    host,
    port: Number.parseInt(process.env.PROXMOX_PORT ?? "8006", 10),
    user: process.env.PROXMOX_USER?.trim() || "root@pam",
    tokenName,
    tokenValue,
    verifySsl: asBool(process.env.PROXMOX_VERIFY_SSL),
  };
}

const filePath = (): string => process.env.CLUSTR_ENDPOINTS_FILE ?? "";

let registry: Map<string, Endpoint> | null = null;
let defaultName = "default";

function load(): Map<string, Endpoint> {
  if (registry) return registry;
  const map = new Map<string, Endpoint>();

  // 1. The single PROXMOX_* host becomes the "default" endpoint, if present.
  const s = singleFromEnv();
  if (s) map.set(s.name, s);

  // 2. CLUSTR_ENDPOINTS (JSON) and 3. the endpoints file *extend* it (and may
  //    override by name), so "one main node + extra clusters" is intuitive.
  const json = process.env.CLUSTR_ENDPOINTS?.trim();
  if (json) for (const e of JSON.parse(json)) map.set(e.name, normalize(e));

  const fp = filePath();
  if (fp && existsSync(fp)) {
    for (const e of JSON.parse(readFileSync(fp, "utf8"))) map.set(e.name, normalize(e));
  }

  registry = map;
  // Prefer an explicit "default" (the single host); otherwise the first entry.
  defaultName = map.has("default") ? "default" : ([...map.keys()][0] ?? "default");
  return map;
}

function persist(): void {
  const fp = filePath();
  if (!fp) {
    throw new Error(
      "Cannot persist endpoint changes: set CLUSTR_ENDPOINTS_FILE to a writable path first.",
    );
  }
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, JSON.stringify([...load().values()], null, 2) + "\n");
}

export function endpoints(): Endpoint[] {
  return [...load().values()];
}
export function endpointNames(): string[] {
  return [...load().keys()];
}
export function getEndpoint(name: string): Endpoint | undefined {
  return load().get(name);
}
export function hasEndpoint(name: string): boolean {
  return load().has(name);
}
export function defaultEndpointName(): string {
  const map = load();
  // Prefer an explicit "default" (the PROXMOX_* single host). Otherwise fall
  // back to the sole/first endpoint, important after a runtime add_endpoint /
  // setup_clustr on a fresh instance, so the new endpoint is usable without
  // having to name it on every call.
  if (map.has(defaultName)) return defaultName;
  return [...map.keys()][0] ?? defaultName;
}
export function isMultiHost(): boolean {
  return load().size > 1;
}

/** Whether endpoint changes can be persisted to disk (an endpoints file is set).
 *  False on a stock desktop install, where durable config lives in the settings
 *  form (OS keychain) instead, so callers can register session-only and tell
 *  the user to paste into the form rather than failing. */
export function canPersistEndpoints(): boolean {
  return Boolean(filePath());
}

export function addEndpoint(e: Record<string, any>, persistToFile = true): Endpoint {
  const ep = normalize(e);
  load().set(ep.name, ep);
  if (persistToFile) persist();
  return ep;
}
export function removeEndpoint(name: string): boolean {
  const ok = load().delete(name);
  if (ok) persist();
  return ok;
}

/** Test/seam hook. */
export function resetEndpoints(): void {
  registry = null;
  defaultName = "default";
}
