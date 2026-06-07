"""
Read-only tool: is the connected Proxmox cluster running the latest release?

Reads the running version from the Proxmox API (``/version``) and compares it to
the latest Proxmox VE release published on the official roadmap
(https://pve.proxmox.com/wiki/Roadmap).

Best-effort by design: the outbound fetch to pve.proxmox.com may be blocked by a
locked-down network policy or simply offline. In that case the running version
is still reported and the upstream lookup degrades to an actionable message
rather than failing the tool. This tool never mutates the cluster, so
``readOnlyHint = True``.
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

_ROADMAP_URL = "https://pve.proxmox.com/wiki/Roadmap"
# Release-history headings on the roadmap read "Proxmox VE X.Y".
_VERSION_RE = re.compile(r"Proxmox VE (\d+)\.(\d+)")
_HTTP_TIMEOUT = 10.0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _running_version() -> str:
    """Return the cluster's running version string from the Proxmox API."""
    # /version returns e.g. {"version": "8.2.4", "release": "8.2", "repoid": ...}
    data: dict[str, Any] = proxmox_get(lambda: get_client().version.get())
    return str(data.get("version") or data.get("release") or "unknown")


def _major_minor(text: str) -> tuple[int, ...]:
    """Parse the leading numeric components of a version string (major, minor)."""
    parts = re.findall(r"\d+", text or "")
    return tuple(int(p) for p in parts[:2])


def _latest_release() -> tuple[str, str | None]:
    """
    Fetch the latest Proxmox VE release from the roadmap.

    Returns ``(version, None)`` on success or ``("", reason)`` on any failure —
    this is the best-effort boundary and never raises.
    """
    try:
        import httpx

        resp = httpx.get(_ROADMAP_URL, timeout=_HTTP_TIMEOUT, follow_redirects=True)
        resp.raise_for_status()
    except Exception as exc:  # noqa: BLE001 — best-effort network boundary
        logger.warning("Update check: roadmap fetch failed: %s", exc)
        return "", f"could not reach the Proxmox roadmap ({exc})"

    matches = _VERSION_RE.findall(resp.text)
    if not matches:
        return "", "could not parse a version from the Proxmox roadmap page"
    latest = max((int(a), int(b)) for a, b in matches)
    return f"{latest[0]}.{latest[1]}", None


def _check_updates() -> str:
    running_ver = _running_version()
    latest_ver, err = _latest_release()

    lines = ["## Proxmox Update Check\n", f"**Running version:** {running_ver}"]

    if err:
        lines.append(f"**Latest release:** unavailable — {err}")
        lines.append(
            "\nThe running version above is read from your cluster. The "
            "latest-release lookup is best-effort and needs outbound access to "
            f"pve.proxmox.com. Check {_ROADMAP_URL} manually."
        )
        return "\n".join(lines)

    lines.append(f"**Latest release (roadmap):** {latest_ver}")

    running_t = _major_minor(running_ver)
    latest_t = _major_minor(latest_ver)

    if running_t and latest_t and running_t < latest_t:
        lines.append(
            f"\n⬆️ **An upgrade is available** — {running_ver} → {latest_ver}. "
            f"Review the upgrade notes before upgrading: {_ROADMAP_URL}"
        )
    elif running_t and latest_t:
        lines.append(
            f"\n✅ You are on the latest minor release ({latest_ver}). Point "
            f"releases and package updates may still be available — run "
            f"`apt update && apt full-upgrade` on each node to be current."
        )
    else:
        lines.append(
            f"\nCould not compare the versions reliably; check {_ROADMAP_URL}."
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
            "released version. Reads the running version from the Proxmox API and "
            "compares it to the latest Proxmox VE release published on the "
            "official roadmap (pve.proxmox.com/wiki/Roadmap). Best-effort: if the "
            "roadmap cannot be reached, the running version is still reported."
        ),
        annotations=_READ_ONLY,
    )
    async def check_proxmox_updates() -> str:
        return await safe("check_proxmox_updates", _check_updates)
