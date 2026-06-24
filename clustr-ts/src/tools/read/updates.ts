/**
 * Read-only tool: is the connected Proxmox cluster running the latest release?
 *
 * Reads the running version from the Proxmox API (/version) and compares it to
 * the latest pve-manager version in Proxmox's APT repository, the structured
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
import { pendingUpdates } from "./apt.js";

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
        "Check for Proxmox updates. Leads with the LOCAL pending-package count " +
        "per node (the Node → Updates panel, instant, no internet from this " +
        "tool) and highlights kernel/PVE updates. Also makes a best-effort " +
        "comparison to the latest release on your track via the public package " +
        "index (skipped cleanly if that can't be reached).",
      annotations: READ,
    },
    async () =>
      safe("check_proxmox_updates", async () => {
        const v = (await proxmoxGet("/version")) as Record<string, any>;
        const runningVer = String(v.version ?? v.release ?? "unknown");
        const runningT = versionTuple(runningVer);
        const lines = ["## Proxmox Update Check\n", `**Running version:** ${runningVer}\n`];

        // Primary, local, reliable: pending APT updates per node.
        const nodes = (await proxmoxGet("/nodes")) as Record<string, any>[];
        lines.push("**Pending package updates (local):**");
        for (const n of nodes) {
          try {
            const { count, notable } = await pendingUpdates(String(n.node));
            if (count === 0) lines.push(`- ${n.node}: ✅ up to date`);
            else
              lines.push(
                `- ${n.node}: ⬆️ ${count} pending` +
                  (notable.length ? ` (incl. ${notable.join(", ")}, reboot likely)` : ""),
              );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            lines.push(`- ${n.node}: could not read pending updates (${msg})`);
          }
        }

        // Secondary, best-effort: latest-on-track from the public index.
        if (runningT.length) {
          const { version: latestVer, error } = await latestOnTrack(runningT[0]);
          if (!error && latestVer) {
            lines.push(
              `\n**Latest on your track (pve-no-subscription):** ${latestVer}` +
                (isLess(runningT, versionTuple(latestVer))
                  ? `, ⬆️ newer than your ${runningVer}.`
                  : ", you're current."),
            );
          }
          // If the external lookup failed, we simply omit it. The local count above is the answer.
        }
        lines.push("\nRun `apt update && apt full-upgrade` on a node to apply (read upgrade notes first).");
        return lines.join("\n");
      }),
  );
}
