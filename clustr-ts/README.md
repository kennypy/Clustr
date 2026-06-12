# Clustr (TypeScript) — Proxmox desktop extension

A TypeScript port of Clustr, packaged as a **Claude Desktop extension** (`.mcpb`).
This is the "install like an app" path: the user double-clicks the bundle, fills
in a settings form (Proxmox host + API token), and the tools appear in Claude —
no terminal, no JSON config, no `.env`.

It runs over **stdio as a local subprocess**, so there is no network port, no
bind, and no transport-auth surface. Safety comes from it being local plus the
scope of the Proxmox API token you provide (use `PVEAuditor` for read-only).

## Multiple Proxmox clusters (multi-host)

One Clustr instance can manage several clusters. The single `PROXMOX_*` fields
are your **`default`** endpoint; add more via:
- **`CLUSTR_ENDPOINTS`** — a JSON array: `[{"name":"office","host":"10.0.0.5","tokenName":"clustr","tokenValue":"…"}]`
- **`CLUSTR_ENDPOINTS_FILE`** — a writable JSON file where the `add_endpoint` /
  `remove_endpoint` tools persist runtime changes.

Every tool then takes an optional **`host`** argument naming which endpoint to
target (omit it for the default). Use `list_endpoints` to see them. Existing
single-host setups are unchanged — `host` just defaults to the one endpoint.

## Building the bundle

`npm run pack` builds and packs `clustr.mcpb` with an auto-incrementing version,
so Claude Desktop always installs it as a *new* version (no uninstall dance).
Pass an explicit version for a release: `npm run pack -- 0.3.0`.

## Status — 75 tools

- ✅ **Multi-host** — manage multiple Proxmox clusters from one instance;
  `list_endpoints` / `add_endpoint` / `remove_endpoint`, plus a `host` arg on
  every tool. `/clustr` slash-menu prompts.
- ✅ Read tools (36): nodes, VMs, containers, storage, update check, backup list
  (VM **and** container), backup jobs, storage content (templates/ISOs/images),
  task follow-up, metrics history (RRD trends), pools, networking + guest IPs,
  pending updates + apt repos, replication, cluster log, and a one-call
  **`cluster_review`**.
- ✅ Write tools (36): power, snapshots, two-step delete, create, backup/restore,
  reconfigure, grow disks, clone, **migrate**, and **downloads**. Same safeguards
  throughout: `confirm=true` on destructive ops, two-step token flows (single-use
  5-min token + exact-identifier match + re-verification), and the hyphenated
  `destroy-unreferenced-disks` param. The delete **request** step is now
  **backup-aware** — it surfaces the node's backup-capable storages (flagging an
  attached **PBS**) and recommends `create_*_backup` or `clone_*` before you
  confirm, so a destructive op points at the safe option instead of hiding it.

### Coverage parity with the Proxmox UI
Tools were added to match the *cheap* endpoints the UI reads instantly, instead
of brute-forcing: `list_backup_jobs` (`/cluster/backup`), `list_node_updates`
(`/apt/update`, local — no internet), `get_metrics_history` (RRD graphs),
`list_pools`/`get_pool`, `list_networks`/`get_guest_ips`, `list_replication`,
`get_cluster_log`. `check_proxmox_updates` now leads with the local apt count
(the roadmap comparison is a best-effort extra). `cluster_review` folds in 24h
node trends, pending updates, and TLS-cert expiry.

### `cluster_review` — the "give me a review" tool
One read-only call that gathers cluster/quorum, per-node usage + version,
networking (bridges/bonds), storage usage, every VM and container, **backup
coverage** (flags running guests with no recent backup), and recent task
failures — ending with an **⚠️ Attention** summary. Run it whenever someone asks
for a review / health check / audit.

### Management & discovery (the "find it / follow it / change it" loop)
- `list_templates` / `list_isos` / `list_storage_content` — discover the paths
  that `create_container`/`create_vm` need (was previously guesswork).
- `list_tasks` / `get_task_status` / `get_task_log` — follow up on the `UPID`
  every write tool returns ("is it done? why did it fail?").
- `update_vm_config` / `update_container_config` — change cores/memory/name/etc.
- `resize_vm_disk` / `resize_container_disk` — grow disks (grow-only).
- `clone_vm` / `clone_container` — clone a guest or template into a new ID.

### Backup & restore (makes deletion recoverable)
- `create_vm_backup` / `create_container_backup` — vzdump (mode
  snapshot/suspend/stop) to a backup-enabled storage. Same call under the hood
  (vzdump is guest-type-agnostic); split into VM/CT tools so the model picks the
  right one. Additive, no confirm.
- `list_vm_backups` / `list_container_backups` — enumerate VM or container
  archives on a storage (returns the `volid` to restore from), across file
  storages and PBS.
- `restore_vm_request` → `restore_vm_confirm` (qmrestore) and
  `restore_container_request` → `restore_container_confirm` (pct restore) —
  two-step restore for VMs and containers. Refuses to overwrite an existing guest
  unless `force=true`, refuses if the target is running, and re-checks right
  before acting. `*_confirm` is destructive.

Full VM/container parity: power, snapshots, delete, create, config, resize,
clone, migrate, **backup, and restore** all have both variants.

These backup/restore tools are TypeScript-only for now (the Python build is at
36 tools); they can be ported to Python later if needed.

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
