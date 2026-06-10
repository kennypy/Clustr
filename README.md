# Clustr

**Proxmox MCP Server** — manage your Proxmox cluster from Claude.

Built to the [Anthropic MCP connector directory standards](https://docs.anthropic.com/en/build-with-claude/mcp).

---

## What it does

Clustr exposes your Proxmox VE infrastructure as MCP tools so you can manage nodes, VMs, and LXC containers directly from Claude. Ask things like:

- *"What's running on my Proxmox cluster right now?"*
- *"Start VM 102 on pve"*
- *"Create a snapshot of container 130 called pre-update"*
- *"How much storage is left on local-lvm?"*
- *"Shutdown all VMs on node pve2 gracefully"*

---

## Tools (36 total)

### Read (15)
| Tool | Description |
|------|-------------|
| `list_nodes` | List all cluster nodes with status and resource usage |
| `get_node` | Detailed CPU, memory, disk, kernel info for a node |
| `get_node_services` | List system services on a node |
| `get_cluster_status` | Cluster health: quorum, node count, VM/CT totals |
| `list_vms` | List all QEMU VMs (optionally filter by node) |
| `get_vm` | Full VM configuration |
| `get_vm_status` | Runtime CPU/memory/I/O metrics for a VM |
| `list_vm_snapshots` | List snapshots for a VM |
| `list_containers` | List all LXC containers |
| `get_container` | Full container configuration |
| `get_container_status` | Runtime metrics for a container |
| `list_container_snapshots` | List snapshots for a container |
| `list_storage` | All storage pools with capacity breakdown |
| `get_storage` | Detailed info for a specific storage pool |
| `check_proxmox_updates` | Compare the cluster's running version to the latest `pve-manager` in Proxmox's APT repo |

### Write — Power (9)
| Tool | Destructive? | Description |
|------|-------------|-------------|
| `start_vm` | No | Start a stopped VM |
| `shutdown_vm` | No | Graceful ACPI shutdown |
| `stop_vm` | **Yes** | Force-stop (data loss possible) |
| `reboot_vm` | No | Graceful reboot |
| `reset_vm` | **Yes** | Hard reset |
| `start_container` | No | Start a stopped container |
| `shutdown_container` | No | Graceful shutdown |
| `stop_container` | **Yes** | Force-stop |
| `reboot_container` | No | Graceful reboot |

### Write — Snapshots (6)
| Tool | Destructive? | Description |
|------|-------------|-------------|
| `create_vm_snapshot` | No | Create a VM snapshot |
| `delete_vm_snapshot` | **Yes** | Delete a VM snapshot |
| `rollback_vm_snapshot` | **Yes** | Rollback VM to snapshot |
| `create_container_snapshot` | No | Create a container snapshot |
| `delete_container_snapshot` | **Yes** | Delete a container snapshot |
| `rollback_container_snapshot` | **Yes** | Rollback container to snapshot |

### Write — Delete (4, two-step)
Deletion is a two-step flow to prevent accidental destruction:

1. Call `vm_delete_request` / `container_delete_request` → get a confirmation token
2. Call `vm_delete_confirm` / `container_delete_confirm` with the token + exact name

Tokens expire after 5 minutes and are single-use. Before deleting, the target
is re-verified against the name captured at request time, so a VMID/CTID that
was deleted and reused in the meantime is never destroyed by a stale token.

### Write — Create (2)
| Tool | Description |
|------|-------------|
| `create_vm` | Create a QEMU VM with CPU, memory, disk, optional ISO |
| `create_container` | Create an LXC container from a template |

---

## Setup

### Prerequisites

- Proxmox VE 7.x or 8.x
- A Proxmox API token (not username/password)
- Python 3.11+ or Docker

### 1. Create a Proxmox API token

In the Proxmox UI:
1. **Datacenter → Permissions → API Tokens → Add**
2. User: `root@pam` (or a dedicated user with appropriate permissions)
3. Token ID: `clustr`
4. Uncheck "Privilege Separation" for full access, or configure granular permissions

### 2. Install Clustr

**Option A: pip (local)**
```bash
git clone https://github.com/kennypy/Clustr.git
cd Clustr
pip install -e .
```

**Option B: Docker**
```bash
git clone https://github.com/kennypy/Clustr.git
cd Clustr
cp .env.example .env
# Edit .env with your Proxmox details
docker compose up -d
```

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
PROXMOX_HOST=192.168.1.1
PROXMOX_USER=root@pam
PROXMOX_TOKEN_NAME=clustr
PROXMOX_TOKEN_VALUE=your-token-secret-here
PROXMOX_VERIFY_SSL=false
```

### 4. Run

**stdio (simplest — for Claude Desktop / local use)**
```bash
clustr --stdio
```
No network port, no exposure — the recommended way to run it on a single machine.

**HTTP (loopback only by default)**
```bash
clustr
# or
clustr --port 9090
```
This binds `127.0.0.1` and has **no authentication** (OAuth is not yet
implemented — see Security). It is meant to sit behind an authenticating reverse
proxy or tunnel. The server **refuses to start** on a non-loopback address while
unauthenticated; do not work around that by exposing it directly — put auth in
front (see Deployment).

---

## Connect to Claude

### Claude Desktop (recommended)
Run it over stdio — no network, no exposure. Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "clustr": {
      "command": "clustr",
      "args": ["--stdio"]
    }
  }
}
```

Or via HTTP if Clustr runs as a service on the same machine:
```json
{
  "mcpServers": {
    "clustr": {
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

### Claude.ai custom connector
A remote connector needs a **public HTTPS URL with authentication in front** —
Claude.ai will not accept a plain `http://<ip>:8080` endpoint, and you should
never expose Clustr's unauthenticated `/mcp` directly. Put it behind an
authenticating tunnel/proxy (see [Deployment](#deployment)), then add the
**HTTPS** URL of that front door under **Settings → Connectors → Add custom
connector**. Until OAuth is implemented (see Security), the front door is what
authenticates callers.

To connect from another machine on your network, two settings must change
(and understand the security note below first):
1. Bind beyond loopback: set `MCP_HOST=0.0.0.0` (already the case inside
   Docker — but the provided compose file publishes the port to the host's
   loopback only, so edit `ports` there too).
2. Allow the Host header clients will send: requests whose `Host` is not
   allow-listed are rejected with `421` (DNS-rebinding protection). Loopback
   (`localhost` / `127.0.0.1`, any port) is always allowed; anything else must
   be added, e.g. `MCP_ALLOWED_HOSTS=192.168.1.50` for
   `http://192.168.1.50:8080/mcp`.

---

## Security

Read this before pointing Clustr at anything you care about.

**Scope the Proxmox token first — this is your real safety net.**
Clustr can only do what its API token is allowed to do, and Proxmox enforces that
regardless of any bug in Clustr or any misfire by the model. Use least privilege:
- **Read-only / first run:** a privilege-separated token granted the `PVEAuditor`
  role. It can list and inspect everything and change *nothing* — write tools
  return `403`. Start here.
  ```bash
  pveum user token add root@pam clustr-ro --privsep 1
  pveum acl modify / --roles PVEAuditor --tokens 'root@pam!clustr-ro'
  ```
- **Writes:** grant `PVEVMAdmin`/`PVEAdmin` **only on a dedicated resource pool**
  (e.g. a `clustr` pool holding the guests you want managed), not datacenter-wide.
  Then a stray delete cannot touch anything outside that pool.

**There is no app-level authentication yet.** OAuth 2.1 is **not implemented** —
the middleware is a stub, and setting `OAUTH_ENABLED=true` currently rejects every
request (it does not provide working auth). So the only functioning mode is
*unauthenticated*. Consequences:
- The server **refuses to start** on a non-loopback address while unauthenticated.
  Run it on `127.0.0.1`/stdio, or put an authenticating proxy/tunnel in front and
  set `MCP_ALLOW_UNAUTHENTICATED=true` to acknowledge that the front door
  authenticates (see Deployment).
- Do **not** publish `/mcp` to a LAN/public address directly. Anyone who reaches
  it has whatever access the Proxmox token grants.

**Transport:** `PROXMOX_VERIFY_SSL=false` (the default, for PVE's self-signed
cert) sends the token over an unverified TLS connection. Keep it on a trusted
network, or install a valid certificate and set it to `true`.

**Bottom line:** today Clustr is appropriate as a **single-user, loopback/stdio**
tool, or behind an authenticating front door. It is not yet suitable to expose
directly or to hand to untrusted callers.

---

## Deployment

Clustr binds to `127.0.0.1` and speaks plain HTTP. Keep it on loopback and let a
front door terminate TLS **and authenticate callers** — that front door is the
access control until OAuth lands.

- **Cloudflare Tunnel (recommended).** Point a tunnel at `http://127.0.0.1:8080`
  and require authentication with **Cloudflare Access** (the tunnel, not Clustr,
  authenticates). Because Clustr stays on loopback, it starts normally with no
  override needed. Set `MCP_PUBLIC_URL=https://clustr.your-domain.com` so the
  advertised resource URL is correct, and add that host to the
  transport-security allow-list (added automatically from `MCP_PUBLIC_URL`; more
  via `MCP_ALLOWED_HOSTS`). If you leave `MCP_PUBLIC_URL` unset, set
  `MCP_TRUST_PROXY=true` so Clustr derives the resource URL from the
  `X-Forwarded-Proto`/`X-Forwarded-Host` headers the tunnel sends — off by
  default because otherwise any client could spoof those headers.

  > If your proxy must reach Clustr over a network (not loopback) — e.g. a proxy
  > in a separate container — you'll bind a non-loopback address and must set
  > `MCP_ALLOW_UNAUTHENTICATED=true` to acknowledge that the proxy is enforcing
  > auth. Only do this when that is actually true.

- **Scaling / multiple workers.** The two-step delete flow keeps confirmation
  tokens **in process memory**. If you run more than one worker or replica,
  enable **sticky sessions** on the proxy so a client's `*_delete_request` and
  `*_delete_confirm` land on the same instance. (A single worker — the default —
  needs nothing.)

---

## Privacy & Terms

See [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md). Host these (or your own
versions) and reference their URLs when submitting to a connector directory.

---

## Development

```bash
pip install -e ".[dev]"
pytest
black src/
ruff check src/
mypy src/
```

---

## Architecture

Clustr is built on **FastMCP** (the high-level MCP server API), which owns the
Streamable HTTP transport and its session lifecycle — there is no hand-rolled
transport code. Each tool module exposes a `register(mcp)` function; `server.py`
constructs the FastMCP instance and registers them all.

```
src/clustr/
├── server.py              # FastMCP instance, tool registration, transports, custom routes
├── config/
│   └── settings.py        # Pydantic v2 settings (.env-aware)
├── proxmox/
│   └── client.py          # proxmoxer wrapper, lock-guarded singleton, retry helpers
├── tools/
│   ├── __init__.py        # `safe()` — turns any tool failure into actionable text
│   ├── read/              # readOnlyHint=true tools
│   │   ├── nodes.py
│   │   ├── vms.py
│   │   ├── containers.py
│   │   ├── storage.py
│   │   └── updates.py       # check_proxmox_updates (best-effort APT-index lookup)
│   └── write/             # mutating tools
│       ├── vm_power.py
│       ├── container_power.py
│       ├── vm_snapshots.py
│       ├── container_snapshots.py
│       ├── vm_delete.py       # two-step deletion
│       ├── container_delete.py
│       ├── vm_create.py
│       └── container_create.py
└── auth/
    └── oauth.py           # OAuth 2.1 middleware (disabled by default)
```

**Design principles:**
- Read and write tools are strictly separated (Anthropic directory requirement)
- Every tool has `title`, `readOnlyHint`, and `destructiveHint` annotations
- All tool names ≤ 64 characters
- Errors are always actionable text — no raw exceptions returned to callers
- All Proxmox calls flow through `proxmox_get`/`proxmox_post`, which translate
  errors and recover once from a dropped connection
- OAuth middleware is a true no-op when disabled — zero overhead
- DNS-rebinding protection on the HTTP transport; loopback always allowed,
  plus the `MCP_PUBLIC_URL` host and any `MCP_ALLOWED_HOSTS` entries

---

## License

MIT

---

## Contributing

Pull requests welcome. Before submitting:
1. `pytest` must pass
2. `ruff check src/` must be clean
3. New tools must follow the existing pattern: separate read/write module, annotations, and a `register(mcp)` function
