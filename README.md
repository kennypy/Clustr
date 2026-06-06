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

## Tools (35 total)

### Read (14)
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

Tokens expire after 5 minutes and are single-use.

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
- Python 3.10+ or Docker

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

**HTTP (primary — for Claude.ai custom connector)**
```bash
clustr
# or
clustr --port 9090
```

**stdio (for Claude Desktop)**
```bash
clustr --stdio
```

---

## Connect to Claude

### Claude.ai custom connector
1. Go to **Settings → Integrations → Add Custom MCP**
2. Enter your server URL: `http://your-server-ip:8080/mcp`

### Claude Desktop
Add to `claude_desktop_config.json`:

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

Or via HTTP (if running as a service):
```json
{
  "mcpServers": {
    "clustr": {
      "url": "http://your-server-ip:8080/mcp"
    }
  }
}
```

---

## Security

**Network access:**
Clustr does not implement authentication by default. Protect the `/mcp` endpoint:
- Bind to `127.0.0.1` for local-only access
- Use a reverse proxy (Nginx, Caddy) with mTLS or IP allowlisting for remote access
- Cloudflare Tunnel with Access rules is the recommended production approach

**OAuth 2.1:**
OAuth 2.1 + PKCE support is stubbed and ready to wire. Set `OAUTH_ENABLED=true` and complete the `TODO` in `src/clustr/auth/oauth.py` to activate full token validation.

**Proxmox permissions:**
For read-only use, create a Proxmox user with `PVEAuditor` role. For write operations, `PVEAdmin` or `Administrator` is required.

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
│   │   └── storage.py
│   └── write/             # mutating tools
│       ├── vm_power.py
│       ├── container_power.py
│       ├── vm_snapshots.py
│       ├── container_snapshots.py
│       ├── vm_delete.py       # two-step deletion
│       ├── container_delete.py
│       ├── vm_create.py
│       └── container_create.py
├── auth/
│   └── oauth.py           # OAuth 2.1 middleware (disabled by default)
└── middleware/
    └── host_verify.py     # Host binding skeleton
```

**Design principles:**
- Read and write tools are strictly separated (Anthropic directory requirement)
- Every tool has `title`, `readOnlyHint`, and `destructiveHint` annotations
- All tool names ≤ 64 characters
- Errors are always actionable text — no raw exceptions returned to callers
- All Proxmox calls flow through `proxmox_get`/`proxmox_post`, which translate
  errors and recover once from a dropped connection
- OAuth middleware is a true no-op when disabled — zero overhead
- DNS-rebinding protection on the HTTP transport; allow-list driven by `MCP_PUBLIC_URL`

---

## License

MIT

---

## Contributing

Pull requests welcome. Before submitting:
1. `pytest` must pass
2. `ruff check src/` must be clean
3. New tools must follow the existing pattern: separate read/write module, annotations, and a `register(mcp)` function
