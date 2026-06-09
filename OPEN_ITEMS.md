# Open items — to review later

Running list of decisions still pending or work deferred. Update as we resolve
them.

## Blocking for the Anthropic directory
- [ ] **OAuth implementation.** `auth/oauth.py` `_validate_token` is still a stub
      (raises `NotImplementedError`). Real OAuth 2.1 (token validation against a
      provider + populated `authorization_servers`) is required for directory
      listing. Also gates per-user credentials below. When wiring it, the JWKS
      helpers need hardening: `_jwks_cache` has no TTL (key rotation breaks it)
      and no lock (concurrent first requests race).
- [ ] **Privacy policy / Terms contacts + hosting.** `PRIVACY.md` and `TERMS.md`
      use placeholder contact emails. Replace with real addresses and host them
      at public URLs to provide during submission.
- [ ] **Public HTTPS hosting.** Cloudflare Tunnel + `MCP_PUBLIC_URL`
      (+ `MCP_ALLOWED_HOSTS`) "will be in place" — not yet done/verified.

## Deferred features
- [ ] **#7 Option B — per-user Proxmox tokens** (each admin sets their own API
      key), auto-trigger once more than 2 users exist. **Depends on OAuth**
      (needs a per-request user identity). Solo self-host uses the single shared
      token (Option A) until then.
- [ ] **Rate limiting.** To be enforced at Cloudflare when/if released publicly
      (≈60 req/min/user, ≈10/min on destructive tools). No app-side code planned.

## Noted, no action
- Initial commit message says "38 tools" (actual: 35). Cosmetic; left as-is per
  decision.

## Resolved (for context)
- HTTP transport → FastMCP `streamable_http_app()` + session-manager lifespan.
- `.env` loading, default bind `127.0.0.1`, OAuth protected-resource metadata.
- Errors return actionable text; stale-connection recovery (reads retry, writes
  reset without re-send).
- Non-blocking tools (async + threadpool offload).
- Confirm safeguard on destructive tools: two-step delete (VM/CT), dry-run
  `confirm` on create and on force-stop/hard-reset/snapshot delete/rollback.
- Lint/type/format clean (ruff, black, mypy --strict); CI runs all four gates.
- CI and Docker install from `uv.lock` (`uv sync --frozen`) — reproducible
  builds; dependency drift now fails the build.
- Full code review (2026-06): Host allow-list now matches Host headers that
  include a port (the SDK needs explicit `:*` entries — portless-only entries
  421'd the default local setup); `X-Forwarded-*` honored only with
  `MCP_TRUST_PROXY=true`; `MCP_ALLOWED_HOSTS` entries also added to allowed
  origins; delete-confirm re-verifies the target name before destroying
  (VMID/CTID reuse guard); Docker healthcheck and compose port respect
  `MCP_PORT`; README/.env.example aligned with actual behavior.
