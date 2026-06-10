/**
 * Shared tool helpers.
 *
 * `safe` wraps a tool body so no exception escapes to the MCP caller — every
 * failure becomes actionable text. `text` builds the MCP result shape, and
 * `needsConfirm` is the standard "not executed — confirm first" message for
 * destructive tools (mirrors the Python implementation).
 */

import { ProxmoxError } from "./proxmox.js";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  [key: string]: unknown;
}

export function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

export async function safe(
  label: string,
  fn: () => Promise<string>,
): Promise<ToolResult> {
  try {
    return text(await fn());
  } catch (err) {
    if (err instanceof ProxmoxError) {
      return text(`Proxmox error: ${err.message}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return text(`Internal error in '${label}': ${msg}`);
  }
}

export function needsConfirm(action: string, target: string): string {
  return (
    `🔎 **Review — not executed.** This will ${action} ${target}, which is ` +
    `destructive and may cause data loss. Call this tool again with the same ` +
    "arguments plus `confirm=true` to proceed."
  );
}

// --- formatting helpers shared across tools ---
export const gb = (bytes: number): number =>
  Math.round((bytes / 1024 ** 3) * 100) / 100;
export const mb = (bytes: number, digits = 0): number => {
  const f = 10 ** digits;
  return Math.round((bytes / 1024 ** 2) * f) / f;
};
export const pct = (fraction: number): number =>
  Math.round(fraction * 100 * 10) / 10;
export const hours = (seconds: number): number =>
  Math.round((seconds / 3600) * 10) / 10;
