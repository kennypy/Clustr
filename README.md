# Clustr

**Proxmox MCP Server** — manage your Proxmox VE cluster from Claude.

Clustr exposes your Proxmox infrastructure as MCP tools so you can inspect and
manage nodes, VMs, and LXC containers directly from Claude — *"what's running on
my cluster?"*, *"snapshot container 130 before I update it"*, *"migrate VM 102 to
pve2"*, *"back up this LXC to my PBS, then delete it"*.

The implementation lives in **[`clustr-ts/`](clustr-ts/)** (TypeScript). **75 tools**
across read, management, backup/restore, and multi-cluster — see
**[clustr-ts/README.md](clustr-ts/README.md)** for the full list and development.

## Two ways to run it

- **Desktop extension (`.mcpb`)** — install like an app into Claude Desktop: fill
  in a settings form (Proxmox host + API token) and the tools appear. Runs locally
  over stdio; no network port. This is the simplest path. See
  [clustr-ts/README.md](clustr-ts/README.md).

- **Remote connector** — run it as a small HTTPS service so you can use it from
  **claude.ai and the mobile app**, protected by Clustr's built-in OAuth 2.1.
  Step-by-step for an on-Proxmox LXC behind a Tailscale Funnel or Cloudflare
  Tunnel: **[clustr-ts/SELF_HOST_LXC.md](clustr-ts/SELF_HOST_LXC.md)**.

## Safety model

Clustr can only do what the **Proxmox API token** you give it is allowed to do —
use a least-privilege token (`PVEAuditor` for read-only). Destructive operations
require an explicit `confirm=true` or a two-step single-use-token flow; deletes
surface a backup/clone prompt (PBS-aware) first. The remote connector fails closed:
it refuses to expose itself without a login password.

## License

MIT — see [LICENSE](LICENSE). [PRIVACY.md](PRIVACY.md) · [TERMS.md](TERMS.md).
