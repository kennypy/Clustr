# Remote Clustr on a Proxmox LXC (phone + web access)

Run Clustr as a small always-on web service in an **LXC on your Proxmox host**, put a
**Cloudflare Tunnel** in front, and add it to Claude as a custom connector — so you
can manage Proxmox from the Claude **phone app** and **claude.ai**, not just the
desktop extension.

```
[Claude phone/web] → [Anthropic] → HTTPS → [Cloudflare Tunnel] → [Clustr (HTTP + OAuth) in an LXC] → [Proxmox API]
```

Clustr authenticates callers with its **own built-in OAuth** (a password you set), so
the tunnel just routes traffic — no Cloudflare Access, no port forwarding, no inbound
ports on your router.

## Read this first — the one caveat
This LXC runs **on the Proxmox host it manages**. If that host is down or off the
network, Clustr is down too — so this is a great tool for day-to-day management and for
problems where the host is *up* (a runaway guest, full storage, a single node down in a
cluster), but it **cannot** rescue you from a host that's fully offline or a **network
lockout** (a bad `vmbr0`/IP change). For those, keep **console/IPMI/physical access** to
the host — that's the real backstop, independent of Clustr. If you want Clustr to survive
the host being down, run it on a separate always-on box instead (same steps, different
home).

## Prerequisites
- A Proxmox host, and a **Proxmox API token** (Datacenter → Permissions → API Tokens).
- A free **Cloudflare account with a domain** (for the tunnel hostname). No domain?
  Tailscale Funnel is an alternative — ask and I'll adapt these steps.
- A few minutes at the Proxmox shell.

---

## 1. Create the LXC
In the Proxmox UI: **Create CT** → unprivileged, **Debian 12**, and modest resources are
plenty (Clustr is a relay, not a workload):

- **Cores:** 1 · **Memory:** 512 MB (1 GB comfortable) · **Disk:** 8 GB
- **Network:** on your normal bridge (e.g. `vmbr0`), DHCP or a static IP. A DHCP
  reservation is nice so the IP is stable.
- Start it, then open its console (or SSH in as root).

```bash
apt update && apt -y upgrade
apt -y install curl git
```

## 2. Install Node 22 + Clustr
```bash
# Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt -y install nodejs

# Clustr
git clone https://github.com/kennypy/Clustr.git /opt/clustr
cd /opt/clustr/clustr-ts
npm ci
npm run build          # compiles dist/
```

## 3. Configuration (secrets in one root-only file)
```bash
install -m 600 /dev/null /etc/clustr.env
nano /etc/clustr.env
```
Fill in (use a **strong** `CLUSTR_AUTH_PASSWORD` — it's your login):
```ini
# Transport
CLUSTR_TRANSPORT=http
CLUSTR_HTTP_HOST=127.0.0.1        # only the local tunnel reaches it; nothing on the LAN
CLUSTR_HTTP_PORT=8080

# Auth (REQUIRED — without a password it refuses to start)
CLUSTR_AUTH_PASSWORD=change-me-to-something-strong
CLUSTR_AUTH_USERNAME=admin
CLUSTR_PUBLIC_URL=https://clustr.yourdomain.com   # MUST equal the tunnel hostname

# Proxmox
PROXMOX_HOST=192.168.1.10
PROXMOX_USER=root@pam
PROXMOX_TOKEN_NAME=clustr
PROXMOX_TOKEN_VALUE=your-token-secret
PROXMOX_VERIFY_SSL=false
```

## 4. Run Clustr as a service
```bash
cat >/etc/systemd/system/clustr.service <<'EOF'
[Unit]
Description=Clustr (Proxmox MCP server, HTTP mode)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/clustr/clustr-ts
EnvironmentFile=/etc/clustr.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=3
# hardening
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now clustr
systemctl status clustr --no-pager        # should be active (running)
curl -s localhost:8080/health             # → {"status":"ok","auth":"oauth"}
```
If `/health` shows `"auth":"oauth"`, the server is up and protected.

## 5. Cloudflare Tunnel (in the same LXC)
1. **Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a tunnel**
   (Cloudflared). Name it, and on the install screen **copy the token** (the long
   `eyJ...` string).
2. Install cloudflared in the LXC and register it as a service with that token:
   ```bash
   curl -fsSL https://pkg.cloudflare.com/cloudflared-stable-linux-$(dpkg --print-architecture).deb -o /tmp/cf.deb
   apt -y install /tmp/cf.deb
   cloudflared service install <PASTE_TUNNEL_TOKEN>
   systemctl status cloudflared --no-pager   # active (running)
   ```
3. Back in the dashboard, add a **Public Hostname** to the tunnel:
   - **Subdomain/domain:** `clustr.yourdomain.com` (must match `CLUSTR_PUBLIC_URL`)
   - **Service:** `HTTP` → `localhost:8080`
4. Verify from anywhere: open **`https://clustr.yourdomain.com/health`** → `{"status":"ok",...}`.

## 6. Add it to Claude (phone + web)
Easiest on **claude.ai** in a browser (the connector then syncs to your phone):
1. **Settings → Connectors → Add custom connector** → paste `https://clustr.yourdomain.com`.
2. Claude discovers the OAuth metadata and sends you to **Clustr's sign-in page** →
   enter `admin` + your `CLUSTR_AUTH_PASSWORD`.
3. Approve → connected. Open the **phone app** → Clustr's tools are there too.

Ask it *"what's running on my Proxmox cluster?"* from your phone to confirm.

---

## Updating
```bash
cd /opt/clustr && git pull
cd clustr-ts && npm ci && npm run build
systemctl restart clustr
```
(`git pull` → `npm run build` → restart — same loop as the desktop build. New tools
appear after the rebuild + restart.)

## Notes & security
- **Tokens are in memory** — restarting the service means signing in again. Fine for one
  instance.
- **Single shared password.** Good for you + a trusted person; it's not multi-user accounts.
- **Least-privilege Proxmox token** still bounds what any caller can do — pair the remote
  connector with a scoped token (e.g. a pool-scoped or `PVEAuditor` token if you only want
  reads).
- Binding `127.0.0.1` means Clustr is reachable **only** through the authenticated tunnel
  and from inside the LXC — never exposed on your LAN.

## Alternative: Docker instead of systemd
If you'd rather use the bundled `Dockerfile` + `docker-compose.yml` (Clustr + cloudflared
in one stack), it works in an LXC too — but Docker-in-LXC needs the container to allow
**nesting**: on the Proxmox host, `pct set <ctid> --features nesting=1` (and keep the LXC
unprivileged). Then `cp .env.example .env`, fill it in, and `docker compose up -d`. The
systemd path above is lighter and avoids that, which is why it's the default here.
