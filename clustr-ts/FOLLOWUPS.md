# Follow-ups (deferred red-team items)

Everything in the red-team's fixable/hard list that could be landed safely
without a live Proxmox has been. This file captures what's left, why it was
deferred, and the intended design — so the decision isn't lost.

## 1. Pinned-fingerprint TLS (replaces the verify_ssl-off default)

**Status: deferred — needs a live host, must not be shipped in pieces.**

Today `verifySsl` defaults to `false` (self-signed homelab certs are the norm),
so the API token rides an unverified connection and is MITM-interceptable on the
LAN. Interim mitigation shipped: a loud one-time per-endpoint warning
(`proxmox.ts`).

The real fix is **certificate pinning**: on first connect, record the server's
SHA-256 cert fingerprint; on every later connect, require an exact match. That
gives real MITM protection for self-signed certs *without* a CA — the right
answer for this audience.

Why it isn't done yet:

- For self-signed certs the TLS chain doesn't validate, so Node/undici's
  `checkServerIdentity` hook never runs (it fires only after chain validation).
  Pinning therefore means `rejectUnauthorized: false` **plus** a manual
  post-handshake fingerprint check via a custom undici connector — fiddly, and
  wrong-either-way (fail-open leaks the token; fail-closed bricks the endpoint).
- That path cannot be validated against a real TLS endpoint from CI/dev here.
- A half-measure is worse than nothing: a `pinnedFingerprint` config field with
  no live wiring behind it hands the user protection they don't actually have.

**Plan when a host is available:** implement the fingerprint compare as a pure,
unit-tested helper (normalise `aa:bb:...` vs `aabb...`, case-insensitive,
constant-time compare); add a custom undici connector that captures the peer
cert and enforces the pin; add `pinnedFingerprint` to the endpoint schema
(optional; when set it *replaces* `verifySsl=false`); validate end-to-end via
`SMOKE_TEST.md` before documenting it as enabled.

## 2. OAuth /login global throttle: backoff vs hard-deny

**Status: deferred — deliberate tradeoff, wants an owner decision.**

`oauth.ts` uses a global fixed-window throttle on `/login` (per-IP is meaningless
behind a tunnel). The foot-gun: an attacker flooding `/login` 429s the legitimate
owner too. The per-authorization `MAX_LOGIN_ATTEMPTS` (5, then the login id is
burned) already bounds real brute force, so the global lockout is mostly
redundant defense-in-depth.

Candidate change: replace the flat global 429 with escalating backoff (delay, not
deny), keeping the per-authorization cap as the real bound. Pure and
unit-testable. It's a small but real change to the auth security posture, so it
should be an explicit decision rather than a drive-by. Left as-is for now.

## 3. Integration testing against real Proxmox

**Status: partially addressed.**

`SMOKE_TEST.md` (the manual pre-release checklist) is the 80/20 and is done.
Runtime `/version` detection (shipped) de-risks the privilege matrix. The heavy
piece — nested-KVM Proxmox in CI — is intentionally **not** built: flaky,
expensive, and not justified until the product warrants it. Revisit if the exec
/ download / restore paths start regressing between releases.

## 4. Minor hygiene (cheap, low-urgency)

- **Console keepalive vs timeout interaction** (`containerExec.ts`): the pure
  parse path is tested; the live websocket timeout-with-partial-output path isn't
  (needs a mock socket). Consider extracting the timeout decision into a pure
  function to test it without a socket.
- **`remove_endpoint` in session-only mode**: `removeEndpoint()` always calls
  `persist()`, which throws when no `CLUSTR_ENDPOINTS_FILE` is set — asymmetric
  with `addEndpoint(persistToFile=false)`. Give remove the same session-only
  escape hatch if that path matters.
