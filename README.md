# Clustr

**Proxmox MCP Server** — manage your Proxmox VE cluster from Claude.

Clustr exposes your Proxmox infrastructure as MCP tools so you can inspect and
manage nodes, VMs, and LXC containers directly from Claude — *"what's running on
my cluster?"*, *"snapshot container 130 before I update it"*, *"migrate VM 102 to
pve2"*, *"back up this LXC to my PBS, then delete it"*.

The implementation lives in **[`clustr-ts/`](clustr-ts/)** (TypeScript). **78 tools**
across read, management, backup/restore, and multi-cluster — see
**[clustr-ts/README.md](clustr-ts/README.md)** for the full list and development.

## Getting a token (streamlined setup)

You need a Proxmox API token. The fastest way: ask Claude *"set up Clustr for
192.168.1.10"* (or run the **`/clustr-setup`** prompt). The **`setup_clustr`**
tool hands you your Proxmox login link plus a one-paste shell snippet that creates
a least-privilege token with exactly the privileges Clustr needs — then you copy
the secret back. If you'd rather not paste a snippet, give it a one-time admin
login and it provisions the token over the API for you (the password is used once
and never stored).

## Two ways to run it

- **Desktop extension (`.mcpb`)** — install like an app into Claude Desktop. All
  settings are optional, so you can install with no token and let `setup_clustr`
  generate one (above), or fill in the Proxmox host + API token form up front.
  Runs locally over stdio; no network port. This is the simplest path. See
  [clustr-ts/README.md](clustr-ts/README.md).

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
