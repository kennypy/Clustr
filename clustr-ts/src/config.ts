/**
 * Clustr configuration — read once from the environment.
 *
 * The desktop extension (.mcpb) injects these from the install-time settings
 * form via the manifest's user_config -> env mapping, so the user never edits a
 * file. Running standalone, they come from the process environment / shell.
 */

export interface ProxmoxConfig {
  host: string;
  port: number;
  user: string;
  tokenName: string;
  tokenValue: string;
  verifySsl: boolean;
}

let cached: ProxmoxConfig | null = null;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Set it in the extension settings (or your environment).`,
    );
  }
  return value;
}

function asBool(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

export function getConfig(): ProxmoxConfig {
  if (cached) return cached;
  cached = {
    host: required("PROXMOX_HOST"),
    port: Number.parseInt(process.env.PROXMOX_PORT ?? "8006", 10),
    user: process.env.PROXMOX_USER?.trim() || "root@pam",
    tokenName: required("PROXMOX_TOKEN_NAME"),
    tokenValue: required("PROXMOX_TOKEN_VALUE"),
    verifySsl: asBool(process.env.PROXMOX_VERIFY_SSL),
  };
  return cached;
}

/** Test/seam hook: drop the cached config so the next call rebuilds it. */
export function resetConfig(): void {
  cached = null;
}
