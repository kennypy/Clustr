"""
Read-only tools for Proxmox storage information.

All tools: readOnlyHint = True, destructiveHint = False.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from clustr.proxmox.client import get_client, proxmox_get
from clustr.tools import safe

logger = logging.getLogger(__name__)

_READ_ONLY = ToolAnnotations(
    readOnlyHint=True, destructiveHint=False, idempotentHint=True
)


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------


def _storage_capacity(p: dict[str, Any]) -> tuple[int, int, int]:
    """
    Return (total, used, avail) bytes, normalizing the two Proxmox endpoints.

    ``/cluster/resources?type=storage`` reports ``maxdisk``/``disk`` (and no
    explicit free figure); ``/nodes/{node}/storage`` reports
    ``total``/``used``/``avail``. Read whichever set is present so the
    node-filtered path doesn't silently render zeros.
    """
    total = int(p.get("maxdisk") or p.get("total") or 0)
    used = int(p.get("disk") or p.get("used") or 0)
    avail_raw = p.get("avail")
    avail = int(avail_raw) if avail_raw is not None else max(total - used, 0)
    return total, used, avail


def _list_storage(node: str | None = None) -> list[dict[str, Any]]:
    if node:
        pools = proxmox_get(lambda: get_client().nodes(node).storage.get())
        for p in pools:
            p["node"] = node
    else:
        pools = proxmox_get(lambda: get_client().cluster.resources.get(type="storage"))

    result = []
    for p in pools:
        total, used, avail = _storage_capacity(p)
        result.append(
            {
                "name": p.get("storage") or p.get("id", "unknown"),
                "node": p.get("node", node or "unknown"),
                "type": p.get("type", "unknown"),
                "status": p.get("status", "unknown"),
                "total_gb": round(total / 1024**3, 2),
                "used_gb": round(used / 1024**3, 2),
                "available_gb": round(avail / 1024**3, 2),
                "used_pct": round(used / total * 100, 1) if total else 0,
            }
        )
    return result


def _get_storage(node: str, storage: str) -> dict[str, Any]:
    info = proxmox_get(lambda: get_client().nodes(node).storage(storage).status.get())
    return {
        "name": storage,
        "node": node,
        "type": info.get("type", "unknown"),
        "total_gb": round(info.get("total", 0) / 1024**3, 2),
        "used_gb": round(info.get("used", 0) / 1024**3, 2),
        "available_gb": round(info.get("avail", 0) / 1024**3, 2),
        "used_pct": (
            round((info.get("used", 0) / info.get("total", 1)) * 100, 1)
            if info.get("total")
            else 0
        ),
    }


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------


def register(mcp: FastMCP) -> None:
    """Register all storage read tools onto the given FastMCP instance."""

    @mcp.tool(
        name="list_storage",
        title="List Storage Pools",
        description=(
            "List all storage pools configured in Proxmox, showing name, type, "
            "total capacity, used space, and available space. "
            "Optionally filter by node name."
        ),
        annotations=_READ_ONLY,
    )
    async def list_storage(
        node: Annotated[
            str, Field(description="Filter to a specific node (optional).")
        ] = "",
    ) -> str:
        return await safe(
            "list_storage",
            lambda: _format_storage_list(_list_storage(node.strip() or None)),
        )

    @mcp.tool(
        name="get_storage",
        title="Get Storage Details",
        description=(
            "Get detailed information for a specific storage pool on a node, "
            "including content types, enabled status, and space breakdown."
        ),
        annotations=_READ_ONLY,
    )
    async def get_storage(
        node: Annotated[str, Field(description="Node name (e.g. 'pve')")],
        storage: Annotated[
            str, Field(description="Storage name (e.g. 'local-lvm', 'fast-media')")
        ],
    ) -> str:
        return await safe(
            "get_storage",
            lambda: _format_storage_detail(_get_storage(node, storage)),
        )


# ---------------------------------------------------------------------------
# Formatters
# ---------------------------------------------------------------------------


def _format_storage_list(pools: list[dict[str, Any]]) -> str:
    if not pools:
        return "No storage pools found."
    lines = [f"## Storage Pools ({len(pools)} total)\n"]
    for p in sorted(pools, key=lambda x: x["name"]):
        bar = _usage_bar(p["used_pct"])
        lines.append(
            f"💾 **{p['name']}** ({p['node']}) — {p['type']}\n"
            f"   {bar} {p['used_pct']}%  "
            f"{p['used_gb']} / {p['total_gb']} GB  "
            f"({p['available_gb']} GB free)"
        )
    return "\n".join(lines)


def _format_storage_detail(p: dict[str, Any]) -> str:
    bar = _usage_bar(p["used_pct"])
    return (
        f"## Storage: {p['name']} on {p['node']}\n\n"
        f"**Type:** {p['type']}\n"
        f"**Total:** {p['total_gb']} GB\n"
        f"**Used:** {p['used_gb']} GB ({p['used_pct']}%)\n"
        f"**Available:** {p['available_gb']} GB\n"
        f"**Usage:** {bar}\n"
    )


def _usage_bar(pct: float, width: int = 10) -> str:
    filled = round(pct / 100 * width)
    return "[" + "█" * filled + "░" * (width - filled) + "]"
