# Clustr (TypeScript): Proxmox desktop extension

A TypeScript port of Clustr, packaged as a **Claude Desktop extension** (`.mcpb`).
This is the "install like an app" path: the user double-clicks the bundle, fills
in a settings form (Proxmox host + API token), and the tools appear in Claude:
no terminal, no JSON config, no `.env`.

It runs over **stdio as a local subprocess**, so there is no network port, no
bind, and no transport-auth surface. Safety comes from it being local plus the
scope of the Proxmox API token you provide (use `PVEAuditor` for read-only).

## Multiple Proxmox clusters (multi-host)

One Clustr instance can manage several clusters. The single `PROXMOX_*` fields
are your **`default`** endpoint; add more via:
- **`CLUSTR_ENDPOINTS`**: a JSON array: `[{"name":"office","host":"10.0.0.5","tokenName":"clustr","tokenValue":"…"}]`
- **`CLUSTR_ENDPOINTS_FILE`**: a writable JSON file where the `add_endpoint` /
  `remove_endpoint` tools persist runtime changes.

Every tool then takes an optional **`host`** argument naming which endpoint to
target (omit it for the default). Use `list_endpoints` to see them. Existing
single-host setups are unchanged: `host` just defaults to the one endpoint.

## Remote mode (phone + web)

The same build runs as a **remote MCP connector** over Streamable HTTP, so it can be
added to claude.ai and the **mobile app**, not just the desktop extension. Set
`CLUSTR_TRANSPORT=http` and a `CLUSTR_AUTH_PASSWORD`, and Clustr runs its **own OAuth 2.1
server** (PKCE + dynamic client registration) and protects `/mcp` with Bearer tokens, no
external identity provider. Stdio stays the default; Express/OAuth load only in HTTP mode,
and it **refuses a non-loopback bind without a password** (fail-closed).

- **[SELF_HOST_LXC.md](SELF_HOST_LXC.md)**: run it in an LXC on your Proxmox host
  (systemd, no Docker) behind a Cloudflare Tunnel. The common path.
- **[SELF_HOST.md](SELF_HOST.md)**: the Docker Compose + cloudflared variant (for a
  separate box / NAS).

## Building the bundle

`npm run pack` builds and packs `clustr.mcpb` with an auto-incrementing version,
so Claude Desktop always installs it as a *new* version (no uninstall dance).
Pass an explicit version for a release: `npm run pack -- 0.3.0`.

## Status: 78 tools

- ✅ **Multi-host**: manage multiple Proxmox clusters from one instance;
  `list_endpoints` / `add_endpoint` / `remove_endpoint`, plus a `host` arg on
  every tool. `/clustr` slash-menu prompts.
- ✅ Read tools (36): nodes, VMs, containers, storage, update check, backup list
  (VM **and** container), backup jobs, storage content (templates/ISOs/images),
  task follow-up, metrics history (RRD trends), pools, networking + guest IPs,
  pending updates + apt repos, replication, cluster log, and a one-call
  **`cluster_review`**.
- ✅ Write tools (37): power, snapshots, two-step delete, create, backup/restore,
  reconfigure, grow disks, clone, **migrate**, and **downloads**. Same safeguards
  throughout: `confirm=true` on destructive ops, two-step token flows (single-use
  5-min token + exact-identifier match + re-verification), and the hyphenated
  `destroy-unreferenced-disks` param. The delete **request** step is now
  **backup-aware**: it surfaces the node's backup-capable storages (flagging an
  attached **PBS**) and recommends `create_*_backup` or `clone_*` before you
  confirm, so a destructive op points at the safe option instead of hiding it.

### Coverage parity with the Proxmox UI
Tools were added to match the *cheap* endpoints the UI reads instantly, instead
of brute-forcing: `list_backup_jobs` (`/cluster/backup`), `list_node_updates`
(`/apt/update`, local, no internet), `get_metrics_history` (RRD graphs),
`list_pools`/`get_pool`, `list_networks`/`get_guest_ips`, `list_replication`,
`get_cluster_log`. `check_proxmox_updates` now leads with the local apt count
(the roadmap comparison is a best-effort extra). `cluster_review` folds in 24h
node trends, pending updates, and TLS-cert expiry.

### `cluster_review`: the "give me a review" tool
One read-only call that gathers cluster/quorum, per-node usage + version,
networking (bridges/bonds), storage usage, every VM and container, **backup
coverage** (flags running guests with no recent backup), and recent task
failures, ending with an **⚠️ Attention** summary. Run it whenever someone asks
for a review / health check / audit.

### Management & discovery (the "find it / follow it / change it" loop)
- `list_templates` / `list_isos` / `list_storage_content` - discover the paths
  that `create_container`/`create_vm` need (was previously guesswork).
- `list_tasks` / `get_task_status` / `get_task_log` - follow up on the `UPID`
  every write tool returns ("is it done? why did it fail?").
- `update_vm_config` / `update_container_config` - change cores/memory/name/etc.
- `resize_vm_disk` / `resize_container_disk` - grow disks (grow-only).
- `clone_vm` / `clone_container` - clone a guest or template into a new ID.

### Backup & restore (makes deletion recoverable)
- `create_vm_backup` / `create_container_backup` - vzdump (mode
  snapshot/suspend/stop) to a backup-enabled storage. Same call under the hood
  (vzdump is guest-type-agnostic); split into VM/CT tools so the model picks the
  right one. Additive, no confirm.
- `list_vm_backups` / `list_container_backups` - enumerate VM or container
  archives on a storage (returns the `volid` to restore from), across file
  storages and PBS.
- `restore_vm_request` → `restore_vm_confirm` (qmrestore) and
  `restore_container_request` → `restore_container_confirm` (pct restore):
  two-step restore for VMs and containers. Refuses to overwrite an existing guest
  unless `force=true`, refuses if the target is running, and re-checks right
  before acting. `*_confirm` is destructive.

Full VM/container parity: power, snapshots, delete, create, config, resize,
clone, migrate, **backup, and restore** all have both variants.

### Run commands inside guests (`run_vm_command` / `run_container_command`)
Run a shell command *inside* a guest and get stdout/stderr/exit code back,
e.g. `apt-get update && apt-get -y upgrade`, or a quick `mkdir`. Both are gated
behind `confirm=true` (preview first, then run) and flagged destructive, since
arbitrary commands are the most powerful thing the token can do. Commands run
through `/bin/sh -c`, so `&&`, pipes, and redirection work; run them
non-interactively (`-y`).

- **`run_vm_command`** (QEMU) uses the **guest agent** (`agent/exec` →
  poll `agent/exec-status`) for clean, structured output. Needs
  `qemu-guest-agent` installed and running in the VM, with the Agent option
  enabled.
- **`run_container_command`** (LXC) has no exec API to call, so it drives the
  container **console** (`termproxy` + `vncwebsocket`): it types a
  marker-wrapped command into the shell and scrapes the output back. That makes
  it best-effort (expects a normal `/bin/sh` prompt, can't split stdout from
  stderr): the container must be running and the token needs `VM.Console`.

### Every tool (alphabetical)

All **78** tools. The *Kind* column: **Read** (no changes), **Write** (mutates, destructive ops gated by `confirm=true` / two-step tokens), **Exec** (runs commands inside a guest), **Setup**, **Endpoint** (multi-cluster management).

<details><summary>Full list of 78 tools</summary>

| Tool | Kind | What it does |
|------|------|--------------|
| `add_endpoint` | Endpoint | Add Proxmox Endpoint |
| `check_proxmox_updates` | Read | Check for Proxmox Updates |
| `clone_container` | Write | Clone Container |
| `clone_vm` | Write | Clone VM |
| `cluster_review` | Read | Review Proxmox Cluster |
| `container_delete_confirm` | Write | Confirm Container Deletion (Step 2 of 2) |
| `container_delete_request` | Write | Request Container Deletion (Step 1 of 2) |
| `create_container` | Write | Create LXC Container |
| `create_container_backup` | Write | Create Container Backup |
| `create_container_snapshot` | Write | Create Container Snapshot |
| `create_vm` | Write | Create Virtual Machine |
| `create_vm_backup` | Write | Create VM Backup |
| `create_vm_snapshot` | Write | Create VM Snapshot |
| `delete_container_snapshot` | Write | Delete Container Snapshot |
| `delete_vm_snapshot` | Write | Delete VM Snapshot |
| `download_from_url` | Write | Download ISO/Template from URL |
| `download_template` | Write | Download Container Template |
| `get_cluster_log` | Read | Get Cluster Log |
| `get_cluster_status` | Read | Get Cluster Status |
| `get_container` | Read | Get Container Details |
| `get_container_status` | Read | Get Container Status |
| `get_guest_ips` | Read | Get Guest IP Addresses |
| `get_metrics_history` | Read | Get Metrics History (Trend) |
| `get_node` | Read | Get Node Details |
| `get_node_services` | Read | Get Node Services |
| `get_pool` | Read | Get Pool Members |
| `get_storage` | Read | Get Storage Details |
| `get_task_log` | Read | Get Task Log |
| `get_task_status` | Read | Get Task Status |
| `get_vm` | Read | Get VM Details |
| `get_vm_status` | Read | Get VM Status |
| `list_apt_repositories` | Read | List APT Repositories |
| `list_available_templates` | Read | List Downloadable Templates |
| `list_backup_jobs` | Read | List Backup Jobs |
| `list_container_backups` | Read | List Container Backups |
| `list_container_snapshots` | Read | List Container Snapshots |
| `list_containers` | Read | List Containers |
| `list_endpoints` | Read | List Proxmox Endpoints |
| `list_isos` | Read | List ISO Images |
| `list_networks` | Read | List Node Network Interfaces |
| `list_node_updates` | Read | List Pending Updates |
| `list_nodes` | Read | List Nodes |
| `list_pools` | Read | List Resource Pools |
| `list_replication` | Read | List Replication Jobs |
| `list_storage` | Read | List Storage Pools |
| `list_storage_content` | Read | List Storage Content |
| `list_tasks` | Read | List Recent Tasks |
| `list_templates` | Read | List Container Templates |
| `list_vm_backups` | Read | List VM Backups |
| `list_vm_snapshots` | Read | List VM Snapshots |
| `list_vms` | Read | List Virtual Machines |
| `migrate_container` | Write | Migrate Container to Another Node |
| `migrate_vm` | Write | Migrate VM to Another Node |
| `reboot_container` | Write | Reboot Container (Graceful) |
| `reboot_vm` | Write | Reboot VM (Graceful) |
| `remove_endpoint` | Endpoint | Remove Proxmox Endpoint |
| `reset_vm` | Write | Reset VM (Hard Reset) |
| `resize_container_disk` | Write | Resize Container Disk (Grow) |
| `resize_vm_disk` | Write | Resize VM Disk (Grow) |
| `restore_container_confirm` | Write | Confirm Container Restore (Step 2 of 2) |
| `restore_container_request` | Write | Request Container Restore (Step 1 of 2) |
| `restore_vm_confirm` | Write | Confirm VM Restore (Step 2 of 2) |
| `restore_vm_request` | Write | Request VM Restore (Step 1 of 2) |
| `rollback_container_snapshot` | Write | Rollback Container to Snapshot |
| `rollback_vm_snapshot` | Write | Rollback VM to Snapshot |
| `run_container_command` | Exec | Run Command in LXC Container (Console) |
| `run_vm_command` | Exec | Run Command in VM (Guest Agent) |
| `setup_clustr` | Setup | Set Up Clustr (Get an API Token) |
| `shutdown_container` | Write | Shutdown Container (Graceful) |
| `shutdown_vm` | Write | Shutdown VM (Graceful) |
| `start_container` | Write | Start Container |
| `start_vm` | Write | Start VM |
| `stop_container` | Write | Stop Container (Force) |
| `stop_vm` | Write | Stop VM (Force) |
| `update_container_config` | Write | Update Container Config |
| `update_vm_config` | Write | Update VM Config |
| `vm_delete_confirm` | Write | Confirm VM Deletion (Step 2 of 2) |
| `vm_delete_request` | Write | Request VM Deletion (Step 1 of 2) |

</details>

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
larger, that's expected.)

## Install (what you ship to a user)

1. Double-click `clustr.mcpb` → Claude Desktop opens an install form. **All fields
   are optional**: you can leave them blank and Install. The server boots without
   a token (you just can't manage anything yet).
2. Ask Claude *"set up Clustr for &lt;your host IP&gt;"* (or run `/clustr-setup`). It
   generates a correctly-scoped API token (see below), then you paste the host +
   token back into the extension's settings form, the secret is stored in your OS
   keychain. *(Already have a token? Skip step 1's blanks and just fill the form.)*
3. Ask Claude *"what's running on my Proxmox cluster?"*

### Streamlined token creation: `setup_clustr`
Step 1 is the part people get wrong (which privileges?). The **`setup_clustr`**
tool (and the **`/clustr-setup`** prompt) automate it. Give it a host IP and it
returns your Proxmox login link plus a single copy-paste `pveum` snippet that
creates a dedicated **`Clustr`** role (least-privilege, covers every management
tool, including `VM.Monitor`/`VM.Console` for the in-guest exec tools), a
`clustr@pve` user, an API token, and the matching ACL, then prints the secret to
paste back. Pass `mode: readonly` for a `PVEAuditor` token instead. Or hand it a
one-time `admin_user` + `admin_password` (with `confirm=true`) and it provisions
the token over the API and registers it for you, the password is used once and
never stored. Because it takes a raw host (not a configured endpoint) and runs
with zero endpoints set up, it works as your very first call.

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
