# Clustr (TypeScript) — Proxmox desktop extension

A TypeScript port of Clustr, packaged as a **Claude Desktop extension** (`.mcpb`).
This is the "install like an app" path: the user double-clicks the bundle, fills
in a settings form (Proxmox host + API token), and the tools appear in Claude —
no terminal, no JSON config, no `.env`.

It runs over **stdio as a local subprocess**, so there is no network port, no
bind, and no transport-auth surface. Safety comes from it being local plus the
scope of the Proxmox API token you provide (use `PVEAuditor` for read-only).

## Status

- ✅ Read tools (15): nodes, VMs, containers, storage, update check.
- ✅ Write tools (21): power, snapshots, two-step delete, create — full 36-tool
  parity with the Python implementation, with the same safeguards: `confirm=true`
  on destructive ops, two-step delete (single-use 5-min token + exact-name match
  + reuse re-verification), and the hyphenated `destroy-unreferenced-disks` param.

## Develop

```bash
npm install
npm run build      # tsc -> dist/
npm test           # node --test (pure-logic unit tests)
```

Smoke-test the MCP handshake + tool list against the built server:
```bash
node smoke.mjs     # (created locally; spawns dist/index.js and lists tools)
```

## Build the installable bundle (.mcpb)

For a slim release bundle, install production deps only, build, then pack:
```bash
npm ci --omit=dev
npm run build
npx @anthropic-ai/mcpb validate manifest.json
npx @anthropic-ai/mcpb pack . clustr.mcpb
```
(During development `npm install` pulls dev deps too, so a dev-time `pack` is
larger — that's expected.)

## Install (what you ship to a user)

1. Create a Proxmox API token (Datacenter → Permissions → API Tokens). Use a
   `PVEAuditor`-scoped token for read-only.
2. Double-click `clustr.mcpb` → Claude Desktop opens an install form → enter the
   host and token → Install. The secret is stored in the OS keychain.
3. Ask Claude *"what's running on my Proxmox cluster?"*

## Configuration

The manifest maps the settings form to these environment variables (also usable
when running standalone):

| Env | Meaning | Default |
|-----|---------|---------|
| `PROXMOX_HOST` | Node IP/hostname (required) | — |
| `PROXMOX_USER` | User with realm | `root@pam` |
| `PROXMOX_TOKEN_NAME` | API token ID (required) | — |
| `PROXMOX_TOKEN_VALUE` | API token secret (required) | — |
| `PROXMOX_PORT` | API port | `8006` |
| `PROXMOX_VERIFY_SSL` | Verify TLS cert | `false` |
