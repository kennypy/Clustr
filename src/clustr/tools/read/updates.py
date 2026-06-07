"""
Read-only tool: is the connected Proxmox cluster running the latest release?

Reads the running version from the Proxmox API (``/version``) and compares it to
the latest ``pve-manager`` version published in Proxmox's APT repository — the
same machine-readable ``Packages`` index that ``apt`` itself consumes. This is
far more stable than scraping wiki/roadmap HTML: it is a structured Debian
``Packages`` file and it yields an exact ``x.y.z``.

The check is **track-aware**: it looks up the Debian codename for the cluster's
*running* major version and queries that track's ``pve-no-subscription`` index.
That means it reports precise point-release updates you'd get from
``apt full-upgrade`` (e.g. 8.2.4 → 8.2.7) and never false-positives on an
in-development next major. Cross-major upgrades (e.g. 8 → 9) are a separate,
deliberate process; the output links to the roadmap for that.

Best-effort by design: the outbound fetch may be blocked by a locked-down
network policy or be offline. In that case the running version is still reported
and the upstream lookup degrades to an actionable message rather than failing.
This tool never mutates the cluster, so ``readOnlyHint = True``.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from clustr.proxmox.client import get_client, proxmox_get
from clustr.tools import safe

logger = logging.getLogger(__name__)

_READ_ONLY = ToolAnnotations(
    readOnlyHint=True, destructiveHint=False, idempotentHint=True
)

# Debian codename per Proxmox VE major. The running major selects the track, so
# this only needs a new entry when a *future* major ships — and an unknown major
# degrades gracefully rather than guessing wrong.
_CODENAMES = {9: "trixie", 8: "bookworm", 7: "bullseye"}

# The structured index apt reads. amd64 is the only Proxmox VE architecture.
_PACKAGES_URL = (
    "https://download.proxmox.com/debian/pve/dists/{codename}"
    "/pve-no-subscription/binary-amd64/Packages"
)
_ROADMAP_URL = "https://pve.proxmox.com/wiki/Roadmap"
_HTTP_TIMEOUT = 15.0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _running_version() -> str:
    """Return the cluster's running version string from the Proxmox API."""
    # /version returns e.g. {"version": "8.2.4", "release": "8.2", "repoid": ...}
    data: dict[str, Any] = proxmox_get(lambda: get_client().version.get())
    return str(data.get("version") or data.get("release") or "unknown")


def _version_tuple(text: str) -> tuple[int, ...]:
    """Parse the leading numeric components of a version string (e.g. 8.2.4)."""
    return tuple(int(p) for p in re.findall(r"\d+", text or "")[:3])


def _parse_pve_manager_version(packages_text: str) -> str | None:
    """
    Extract the highest ``pve-manager`` version from a Debian ``Packages`` file.

    Stanzas are blank-line separated; we match the ``pve-manager`` stanza exactly
    (not, say, ``pve-manager-foo``) and take the max ``Version:`` across any
    matches.
    """
    best: tuple[int, ...] | None = None
    best_str: str | None = None
    for stanza in packages_text.split("\n\n"):
        if not re.search(r"^Package: pve-manager$", stanza, re.MULTILINE):
            continue
        m = re.search(r"^Version: (\S+)$", stanza, re.MULTILINE)
        if not m:
            continue
        ver = m.group(1)
        parsed = _version_tuple(ver)
        if parsed and (best is None or parsed > best):
            best = parsed
            best_str = ver
    return best_str


def _latest_on_track(major: int) -> tuple[str, str | None]:
    """
    Fetch the latest ``pve-manager`` version for the running major's track.

    Returns ``(version, None)`` on success or ``("", reason)`` on any failure —
    this is the best-effort boundary and never raises.
    """
    codename = _CODENAMES.get(major)
    if codename is None:
        return "", (
            f"unrecognized Proxmox VE release track (major {major}); cannot map it "
            f"to a Debian repository"
        )

    url = _PACKAGES_URL.format(codename=codename)
    try:
        import httpx

        resp = httpx.get(url, timeout=_HTTP_TIMEOUT, follow_redirects=True)
        resp.raise_for_status()
    except Exception as exc:  # noqa: BLE001 — best-effort network boundary
        logger.warning("Update check: package index fetch failed (%s): %s", url, exc)
        return "", f"could not reach the Proxmox package index ({exc})"

    latest = _parse_pve_manager_version(resp.text)
    if latest is None:
        return "", f"could not find pve-manager in the {codename} package index"
    return latest, None


def _check_updates() -> str:
    running_ver = _running_version()
    running_t = _version_tuple(running_ver)

    lines = ["## Proxmox Update Check\n", f"**Running version:** {running_ver}"]

    if not running_t:
        lines.append(
            "\nCould not parse the running version from the Proxmox API, so no "
            f"comparison was made. Check {_ROADMAP_URL}."
        )
        return "\n".join(lines)

    latest_ver, err = _latest_on_track(running_t[0])
    if err:
        lines.append(f"**Latest release:** unavailable — {err}")
        lines.append(
            "\nThe running version above is read from your cluster. The "
            "latest-release lookup is best-effort and needs outbound access to "
            f"download.proxmox.com. Check for updates manually or see {_ROADMAP_URL}."
        )
        return "\n".join(lines)

    latest_t = _version_tuple(latest_ver)
    lines.append(f"**Latest on your track (pve-no-subscription):** {latest_ver}")

    if running_t < latest_t:
        lines.append(
            f"\n⬆️ **An update is available** — {running_ver} → {latest_ver}. "
            f"Run `apt update && apt full-upgrade` on each node (read the upgrade "
            f"notes first). For a new *major* release, see {_ROADMAP_URL}."
        )
    else:
        lines.append(
            f"\n✅ You are on the latest release for this track ({latest_ver}). "
            f"New *major* releases are announced separately — see {_ROADMAP_URL}."
        )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------


def register(mcp: FastMCP) -> None:
    """Register the update-check tool onto the given FastMCP instance."""

    @mcp.tool(
        name="check_proxmox_updates",
        title="Check for Proxmox Updates",
        description=(
            "Check whether the connected Proxmox cluster is running the latest "
            "release. Reads the running version from the Proxmox API and compares "
            "it to the latest pve-manager version in Proxmox's APT repository "
            "(the pve-no-subscription package index for the cluster's release "
            "track). Reports precise point-release updates available via "
            "apt full-upgrade. Best-effort: if the package index cannot be "
            "reached, the running version is still reported."
        ),
        annotations=_READ_ONLY,
    )
    async def check_proxmox_updates() -> str:
        return await safe("check_proxmox_updates", _check_updates)
