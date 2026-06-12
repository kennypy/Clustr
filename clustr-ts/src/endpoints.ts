/**
 * Endpoint registry — Clustr can manage several Proxmox clusters from one
 * instance. Endpoints come from (in priority order):
 *   1. CLUSTR_ENDPOINTS         — a JSON array of endpoint objects
 *   2. CLUSTR_ENDPOINTS_FILE    — a writable JSON file (also where add/remove
 *                                 persist), so endpoints can be managed at runtime
 *   3. PROXMOX_* env            — the single-endpoint shortcut (named "default"),
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

function normalize(e: Record<string, any>): Endpoint {
  if (!e.name || !e.host || !e.tokenName || !e.tokenValue) {
    throw new Error(
      "Each endpoint needs name, host, tokenName, tokenValue (user/port/verifySsl optional).",
    );
  }
  return {
    name: String(e.name),
    host: String(e.host),
    port: Number(e.port ?? 8006),
    user: String(e.user ?? "root@pam"),
    tokenName: String(e.tokenName),
    tokenValue: String(e.tokenValue),
    verifySsl: asBool(e.verifySsl),
  };
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
  //    override by name) — so "one main node + extra clusters" is intuitive.
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
  load();
  return defaultName;
}
export function isMultiHost(): boolean {
  return load().size > 1;
}

export function addEndpoint(e: Record<string, any>): Endpoint {
  const ep = normalize(e);
  load().set(ep.name, ep);
  persist();
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
