/**
 * Runtime Proxmox version detection.
 *
 * A few tools depend on the node's PVE version (notably download_from_url, which
 * needs `Sys.AccessNetwork` — a privilege that only exists on PVE 8.2+). Rather
 * than assume, we ask `/version` once per endpoint (cached) so a version-gated
 * failure can be explained precisely ("this node is 8.1, that tool needs 8.2+")
 * instead of surfacing a bare 403.
 *
 * The parse/compare helpers are pure and unit-tested; the fetch is a thin,
 * cached wrapper over proxmoxGet that never throws (detection is best-effort).
 */

import { activeEndpointName, proxmoxGet } from "./proxmox.js";

export interface ProxmoxVersion {
  /** Raw version string as reported, e.g. "8.2.2". */
  version: string;
  major: number;
  minor: number;
}

/** Parse Proxmox's `/version` payload (`{ version: "8.2.2", ... }`) into a
 *  structured version, or null if it isn't shaped as expected. Pure. */
export function parseVersion(raw: unknown): ProxmoxVersion | null {
  const v = (raw as { version?: unknown })?.version;
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d+)\.(\d+)/);
  if (!m) return null;
  return { version: v, major: Number(m[1]), minor: Number(m[2]) };
}

/** True if `v` is at least `major.minor`. Null (unknown) is treated as "not at
 *  least" so callers fail safe / stay conservative. Pure. */
export function atLeast(
  v: ProxmoxVersion | null,
  major: number,
  minor: number,
): boolean {
  if (!v) return false;
  return v.major > major || (v.major === major && v.minor >= minor);
}

// One resolved version per endpoint name. Versions don't change mid-session
// (short of an upgrade + restart), so a plain cache is fine.
const cache = new Map<string, ProxmoxVersion>();

/**
 * Fetch (and cache) the active endpoint's Proxmox version. Best-effort: returns
 * null if the call fails or the payload is unexpected, so callers can degrade
 * gracefully rather than turn a detection miss into a hard error.
 */
export async function getProxmoxVersion(
  force = false,
): Promise<ProxmoxVersion | null> {
  const key = activeEndpointName();
  if (!force) {
    const hit = cache.get(key);
    if (hit) return hit;
  }
  try {
    const parsed = parseVersion(await proxmoxGet("/version"));
    if (parsed) cache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** Test/seam hook: drop cached versions. */
export function resetVersionCache(): void {
  cache.clear();
}
