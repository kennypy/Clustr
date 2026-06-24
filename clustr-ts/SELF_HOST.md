# Self-host Clustr as a remote connector

Run Clustr on your own network so you (or people you share it with) can manage
Proxmox **from claude.ai and the mobile app**, anywhere, not just the desktop
extension. Each person runs their *own* instance next to their *own* Proxmox;
no credentials ever leave their network.

```
[Claude web/mobile] ──HTTPS──▶ [Cloudflare Tunnel] ──▶ [Clustr (built-in OAuth)] ──▶ [Proxmox API]
```

Clustr authenticates callers with its **own OAuth** (a password you set), so the
tunnel just routes traffic: no central service, no shared secrets.

## Prerequisites
- Docker + Docker Compose on a box that can reach your Proxmox API.
- A Cloudflare account with a domain (free tier is fine) for the tunnel.
- A Proxmox API token (use a least-privilege one: `PVEAuditor` for read-only).

## Steps

1. **Get the code and configure**
   ```bash
   git clone https://github.com/kennypy/Clustr.git
   cd Clustr/clustr-ts
   cp .env.example .env
   ```
   Edit `.env`: your `PROXMOX_*` token, a **strong `CLUSTR_AUTH_PASSWORD`**, and
   `CLUSTR_PUBLIC_URL` (the HTTPS hostname your tunnel will serve, e.g.
   `https://clustr.yourdomain.com`).

2. **Create a Cloudflare Tunnel**
   - Cloudflare dashboard → Zero Trust → Networks → Tunnels → **Create a tunnel**
     (Cloudflared).
   - Copy the **tunnel token** into `TUNNEL_TOKEN` in `.env`.
   - Add a **public hostname** (newer dashboards call this **Published application
     routes**, on the tunnel itself, not Networks → Routes): your
     `clustr.yourdomain.com` → service `http://clustr:8080`.

3. **Start it**
   ```bash
   docker compose up -d
   ```
   The container refuses to start unless `CLUSTR_AUTH_PASSWORD` is set: that's
   the fail-closed guard. Check it's healthy: `docker compose ps`.

4. **Add the connector in Claude**
   - claude.ai → Settings → Connectors → **Add custom connector** → enter your
     `CLUSTR_PUBLIC_URL` **with `/mcp` appended** (e.g.
     `https://clustr.yourdomain.com/mcp`). The MCP endpoint is `/mcp`; the bare root
     returns 404 ("no MCP server found").
   - Claude discovers the OAuth metadata and sends you to Clustr's sign-in page;
     enter your password. Done: it now works on web and mobile.

## Notes
- **Multiple clusters:** add `CLUSTR_ENDPOINTS` (JSON) to `.env`, or set
  `CLUSTR_ENDPOINTS_FILE` to a mounted path and use the `add_endpoint` tool.
- **Security posture:** the Proxmox token still scopes what any caller can do:
  pair the remote connector with a least-privilege (ideally pool-scoped) token.
  Tokens issued by Clustr's OAuth live in memory, so a restart means re-login.
- **Don't put Cloudflare Access in front.** Its interactive browser login can't be
  completed by Anthropic's servers and breaks the connector handshake. Clustr's own
  OAuth is the gate. If you want brute-force protection on top, add something like
  fail2ban on the sign-in route rather than an Access policy.
- This is single-instance self-host by design. There is intentionally **no**
  central/hosted service holding anyone's Proxmox credentials.
