# Clustr

**Proxmox MCP Server** — manage your Proxmox VE cluster from Claude.

Clustr exposes your Proxmox infrastructure as MCP tools so you can inspect and
manage nodes, VMs, and LXC containers directly from Claude — *"what's running on
my cluster?"*, *"snapshot container 130 before I update it"*, *"migrate VM 102 to
pve2"*, *"back up this LXC to my PBS, then delete it"*.

The implementation lives in **[`clustr-ts/`](clustr-ts/)** (TypeScript). **75 tools**
across read, management, backup/restore, and multi-cluster — see
**[clustr-ts/README.md](clustr-ts/README.md)** for the full list and development.

## Choose your install

Everyone runs their **own** instance against their **own** cluster — there's no
hosted service and no shared credentials. Pick the path that fits:

| | Best for | How |
|---|---|---|
| **Desktop extension (`.mcpb`)** | Claude Desktop on one machine. Simplest — no network, no domain, no password. | Download the `.mcpb` from [Releases](https://github.com/kennypy/Clustr/releases), open it in Claude Desktop, fill in Proxmox host + API token. See [clustr-ts/README.md](clustr-ts/README.md). |
| **Remote connector** | Using it from **claude.ai and the mobile app**, anywhere. | Run it as a small HTTPS service behind a Cloudflare Tunnel or Tailscale Funnel, gated by Clustr's built-in OAuth 2.1. Add it in Claude with the **`/mcp`** URL (e.g. `https://clustr.example.com/mcp`). Full guide: **[clustr-ts/SELF_HOST_LXC.md](clustr-ts/SELF_HOST_LXC.md)**. |

> **Remote security in one line:** the endpoint is public and the only gate is your
> `CLUSTR_AUTH_PASSWORD` — use a long random one (it's effectively root on the host),
> keep the Proxmox token least-privilege, bind Clustr to `127.0.0.1`, and let the
> tunnel be the sole ingress. Do **not** add Cloudflare Access (it breaks the connector).

## Safety model

Clustr can only do what the **Proxmox API token** you give it is allowed to do —
use a least-privilege token (`PVEAuditor` for read-only). Destructive operations
require an explicit `confirm=true` or a two-step single-use-token flow; deletes
surface a backup/clone prompt (PBS-aware) first. The remote connector fails closed:
it refuses to expose itself without a login password.

## License

MIT — see [LICENSE](LICENSE). [PRIVACY.md](PRIVACY.md) · [TERMS.md](TERMS.md).
