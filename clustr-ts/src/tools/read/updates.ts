/**
 * Read-only tool: is the connected Proxmox cluster running the latest release?
 *
 * Reads the running version from the Proxmox API (/version) and compares it to
 * the latest pve-manager version in Proxmox's APT repository — the structured
 * Packages index apt itself consumes. Track-aware: it maps the running major to
 * its Debian codename and queries that track, so it reports the precise
 * point-release apt would install and never false-positives on an
 * in-development next major.
 *
 * Best-effort: if the package index is unreachable (offline / locked-down
 * network), the running version is still reported.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetch } from "undici";

import { proxmoxGet } from "../../proxmox.js";
import { safe } from "../../safe.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

const CODENAMES: Record<number, string> = { 9: "trixie", 8: "bookworm", 7: "bullseye" };
const ROADMAP_URL = "https://pve.proxmox.com/wiki/Roadmap";
const packagesUrl = (codename: string): string =>
  `https://download.proxmox.com/debian/pve/dists/${codename}` +
  `/pve-no-subscription/binary-amd64/Packages`;

function versionTuple(text: string): number[] {
  return (text.match(/\d+/g) ?? []).slice(0, 3).map(Number);
}

function isLess(a: number[], b: number[]): boolean {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** Highest pve-manager Version: from a Debian Packages index, or null. */
export function parsePveManagerVersion(packagesText: string): string | null {
  let best: number[] | null = null;
  let bestStr: string | null = null;
  for (const stanza of packagesText.split("\n\n")) {
    if (!/^Package: pve-manager$/m.test(stanza)) continue;
    const m = stanza.match(/^Version: (\S+)$/m);
    if (!m) continue;
    const parsed = versionTuple(m[1]);
    if (parsed.length && (best === null || isLess(best, parsed))) {
      best = parsed;
      bestStr = m[1];
    }
  }
  return bestStr;
}

async function latestOnTrack(
  major: number,
): Promise<{ version: string; error: string | null }> {
  const codename = CODENAMES[major];
  if (!codename) {
    return {
      version: "",
      error: `unrecognized Proxmox VE release track (major ${major}); cannot map it to a Debian repository`,
    };
  }
  try {
    const resp = await fetch(packagesUrl(codename), {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      return { version: "", error: `package index returned HTTP ${resp.status}` };
    }
    const latest = parsePveManagerVersion(await resp.text());
    if (!latest) {
      return {
        version: "",
        error: `could not find pve-manager in the ${codename} package index`,
      };
    }
    return { version: latest, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { version: "", error: `could not reach the Proxmox package index (${msg})` };
  }
}

export function register(server: McpServer): void {
  server.registerTool(
    "check_proxmox_updates",
    {
      title: "Check for Proxmox Updates",
      description:
        "Check whether the connected Proxmox cluster is running the latest " +
        "release. Compares the running version (from the Proxmox API) to the " +
        "latest pve-manager in Proxmox's APT repository for the cluster's " +
        "release track. Best-effort if the index cannot be reached.",
      annotations: READ,
    },
    async () =>
      safe("check_proxmox_updates", async () => {
        const v = (await proxmoxGet("/version")) as Record<string, any>;
        const runningVer = String(v.version ?? v.release ?? "unknown");
        const runningT = versionTuple(runningVer);

        const lines = ["## Proxmox Update Check\n", `**Running version:** ${runningVer}`];
        if (!runningT.length) {
          lines.push(`\nCould not parse the running version. Check ${ROADMAP_URL}.`);
          return lines.join("\n");
        }

        const { version: latestVer, error } = await latestOnTrack(runningT[0]);
        if (error) {
          lines.push(`**Latest release:** unavailable — ${error}`);
          lines.push(
            `\nThe running version above is from your cluster. The latest-release ` +
              `lookup is best-effort and needs outbound access to ` +
              `download.proxmox.com. See ${ROADMAP_URL}.`,
          );
          return lines.join("\n");
        }

        lines.push(`**Latest on your track (pve-no-subscription):** ${latestVer}`);
        if (isLess(runningT, versionTuple(latestVer))) {
          lines.push(
            `\n⬆️ **An update is available** — ${runningVer} → ${latestVer}. ` +
              `Run \`apt update && apt full-upgrade\` on each node (read the ` +
              `upgrade notes first). For a new major release, see ${ROADMAP_URL}.`,
          );
        } else {
          lines.push(
            `\n✅ You are on the latest release for this track (${latestVer}). ` +
              `New major releases are announced separately — see ${ROADMAP_URL}.`,
          );
        }
        return lines.join("\n");
      }),
  );
}
