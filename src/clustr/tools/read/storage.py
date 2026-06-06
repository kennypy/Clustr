"""
Read-only tools for Proxmox storage information.

All tools: readOnlyHint = True, destructiveHint = False.
"""
from __future__ import annotations

import logging
from typing import Any

from mcp.types import TextContent, Tool

from clustr.proxmox.client import ProxmoxError, get_client

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

TOOL_LIST_STORAGE = Tool(
    name="list_storage",
    title="List Storage Pools",
    description=(
        "List all storage pools configured in Proxmox, showing name, type, "
        "total capacity, used space, and available space. "
        "Optionally filter by node name."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {
                "type": "string",
                "description": "Filter to a specific node (optional).",
            }
        },
        "required": [],
    },
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
    },
)

TOOL_GET_STORAGE = Tool(
    name="get_storage",
    title="Get Storage Details",
    description=(
        "Get detailed information for a specific storage pool on a node, "
        "including content types, enabled status, and space breakdown."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {
                "type": "string",
                "description": "Node name (e.g. 'pve')",
            },
            "storage": {
                "type": "string",
                "description": "Storage name (e.g. 'local-lvm', 'fast-media')",
            },
        },
        "required": ["node", "storage"],
    },
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
    },
)


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def _list_storage(node: str | None = None) -> list[dict[str, Any]]:
    client = get_client()
    if node:
        pools = client.nodes(node).storage.get()
        for p in pools:
            p["node"] = node
    else:
        resources = client.cluster.resources.get(type="storage")
        pools = resources

    return [
        {
            "name": p.get("storage") or p.get("id", "unknown"),
            "node": p.get("node", node or "unknown"),
            "type": p.get("type", "unknown"),
            "status": p.get("status", "unknown"),
            "total_gb": round(p.get("maxdisk", 0) / 1024**3, 2),
            "used_gb": round(p.get("disk", 0) / 1024**3, 2),
            "available_gb": round(
                (p.get("maxdisk", 0) - p.get("disk", 0)) / 1024**3, 2
            ),
            "used_pct": round(
                (p.get("disk", 0) / p.get("maxdisk", 1)) * 100, 1
            ) if p.get("maxdisk") else 0,
        }
        for p in pools
    ]


def _get_storage(node: str, storage: str) -> dict[str, Any]:
    client = get_client()
    info = client.nodes(node).storage(storage).status.get()
    return {
        "name": storage,
        "node": node,
        "type": info.get("type", "unknown"),
        "total_gb": round(info.get("total", 0) / 1024**3, 2),
        "used_gb": round(info.get("used", 0) / 1024**3, 2),
        "available_gb": round(info.get("avail", 0) / 1024**3, 2),
        "used_pct": round(
            (info.get("used", 0) / info.get("total", 1)) * 100, 1
        ) if info.get("total") else 0,
    }


# ---------------------------------------------------------------------------
# Handler dispatcher
# ---------------------------------------------------------------------------

async def handle(tool_name: str, arguments: dict[str, Any]) -> list[TextContent]:
    try:
        if tool_name == "list_storage":
            node = arguments.get("node", "").strip() or None
            result = _list_storage(node)
            text = _format_storage_list(result)

        elif tool_name == "get_storage":
            node = arguments.get("node", "").strip()
            storage = arguments.get("storage", "").strip()
            if not node:
                return [TextContent(type="text", text="Error: 'node' parameter is required.")]
            if not storage:
                return [TextContent(type="text", text="Error: 'storage' parameter is required.")]
            result = _get_storage(node, storage)
            text = _format_storage_detail(result)

        else:
            return [TextContent(type="text", text=f"Unknown tool: {tool_name}")]

    except ProxmoxError as exc:
        logger.error("Proxmox error in %s: %s", tool_name, exc)
        return [TextContent(type="text", text=f"Proxmox error: {exc}")]

    return [TextContent(type="text", text=text)]


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
