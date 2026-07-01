# Clustr manual smoke test

The unit suite (`npm test`) is entirely pure: mocks and captured transcripts, no
live Proxmox. That's fast and deterministic, but it means a whole class of bugs —
anything that depends on real API behaviour, privileges, or the LXC console
protocol — is invisible to CI. (The `Sys.AccessNetwork` download-privilege gap
was exactly this: every test passed while the advertised tool 403'd on a real
node.)

This checklist covers the paths a mock can't. **Run it against a real cluster
before each release**, or at least when touching the exec, download, restore, or
setup paths. It's deliberately manual — standing up nested-KVM Proxmox in CI is a
heavy, flaky investment we're not making yet.

## Prerequisites

- A reachable Proxmox VE node (ideally two, to exercise multi-host + migrate).
- Note the PVE version: `pveversion` on the node, or `get_cluster_status`. Some
  steps below branch on 8.2+ vs older.
- A least-privilege token created by `setup_clustr` (full mode), so you're
  testing the **real** privilege set, not a root token that masks missing privs.
- At least one stopped LXC container and one QEMU VM you can safely mutate. The
  VM should have `qemu-guest-agent` installed for the exec test.

## 1. Onboarding / privileges (the mock blind spot)

- [ ] `setup_clustr` (guided): returns the login URL + `pveum` snippet; running
      the snippet on the node creates the token and prints a secret.
- [ ] `setup_clustr` with `admin_user`/`admin_password` + `confirm=true`:
      provisions role + user + token + ACL over the API and reports "Verified it
      works."
- [ ] Refuse-insecure-TLS guard: same call with `verify_ssl=false` and no
      `allow_insecure_tls` must **refuse** before sending the password.
- [ ] With the resulting least-privilege token, every management tool below
      works — no unexpected 403. This is the check that would have caught the
      `Sys.AccessNetwork` gap.

## 2. Read paths (sanity)

- [ ] `list_nodes`, `list_vms`, `list_containers`, `get_cluster_status`,
      `list_storage`, `list_storage_content`, `get_metrics_history` all return
      plausible data.
- [ ] TLS-off warning: with `verifySsl=false`, the server logs the one-time
      "TLS verification is OFF" warning to stderr on the first request per
      endpoint (and only once).

## 3. Download (version-gated — the privilege matrix)

- [ ] **PVE 8.2+**: `download_from_url` (a small ISO) succeeds with the
      least-privilege token (validates `Sys.AccessNetwork` is sufficient).
- [ ] **PVE 8.0 / 8.1** (if you have one): the same call returns the *specific*
      message naming the node version and telling you to grant `Sys.Modify` or
      upgrade — **not** a bare 403. This exercises runtime `/version` detection.
- [ ] `download_template` from the appliance index onto a storage succeeds.
- [ ] A bogus `storage` containing a `/` (e.g. `local/../qemu`) is rejected up
      front with "Invalid `storage`" (path-injection guard).

## 4. LXC console exec (the fragile scrape path)

- [ ] Container with an **auto-login root shell** console (`pct set <ctid>
      --cmode shell`): `run_container_command` with `confirm=true` runs the
      command and returns output + exit code. Try one with a pipe/`&&` to
      confirm the shell wrapping works.
- [ ] Container with the **default `tty` console** (getty login prompt):
      `run_container_command` **fails fast** with the "shows a login prompt…"
      guidance, and does **not** hang until timeout. This is the login-prompt
      detection.
- [ ] Guest output is prefixed with the "Untrusted output from the guest" note.
- [ ] A long-running command near `timeout_seconds` reports a timeout with any
      partial output, rather than erroring out.

## 5. VM guest-agent exec

- [ ] VM with `qemu-guest-agent`: `run_vm_command` returns structured
      stdout/stderr + exit code.
- [ ] VM **without** the agent: returns the actionable "install
      qemu-guest-agent / enable the Agent option" message, not a raw error.

## 6. Destructive two-step + confirm gates

- [ ] `container_delete_request` → returns token + hostname + backup/clone hint.
- [ ] `container_delete_confirm` with the token + **wrong** hostname is rejected
      (hostname mismatch guard).
- [ ] Delete-confirm after the CTID has been reused for a different container
      (rename or recreate between request and confirm) is rejected with the
      "CTID may have been reused" message. Nothing is deleted.
- [ ] Any `confirm=false` destructive call returns a preview and does nothing.
- [ ] Snapshot create/rollback/delete round-trips on both a VM and a container.

## 7. Multi-host (if you have two nodes/clusters)

- [ ] `add_endpoint` a second cluster; `list_endpoints` shows both.
- [ ] A tool call with `host: <second>` targets the right cluster.
- [ ] `remove_endpoint` of the current default: subsequent default-routed calls
      resolve to the remaining endpoint (no dangling default).
- [ ] `migrate_vm` / `migrate_container` between two nodes in one cluster.

## 8. Remote connector (HTTP + OAuth), if shipping that path

- [ ] Start in HTTP mode with `CLUSTR_AUTH_PASSWORD` set; `/health` reports
      `auth: oauth`.
- [ ] Non-loopback bind with **no** password refuses to start (fail-closed).
- [ ] Full OAuth dance from claude.ai/mobile: login page → password → connected.
- [ ] Wrong password: after 5 attempts the login id is burned; the global
      throttle 429s a flood.

---

When a step fails, capture the tool output and the node's `pveversion` — those
two together are almost always enough to localise it.
