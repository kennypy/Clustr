"""
Read-only tools for LXC container information.

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

TOOL_LIST_CONTAINERS = Tool(
    name="list_containers",
    title="List Containers",
    description=(
        "List all LXC containers across all nodes, showing container ID, "
        "name, status, CPU, and memory. Optionally filter by node name."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {
                "type": "string",
                "description": "Filter to a specific node name (optional).",
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

TOOL_GET_CONTAINER = Tool(
    name="get_container",
    title="Get Container Details",
    description=(
        "Get the full configuration for a specific LXC container: "
        "CPU, memory, storage mounts, network interfaces, and startup settings."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {
                "type": "string",
                "description": "Node name where the container resides",
            },
            "ctid": {
                "type": "integer",
                "description": "Container ID number (e.g. 103)",
                "minimum": 100,
            },
        },
        "required": ["node", "ctid"],
    },
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
    },
)

TOOL_GET_CONTAINER_STATUS = Tool(
    name="get_container_status",
    title="Get Container Status",
    description=(
        "Get current runtime status for an LXC container: power state, "
        "CPU usage, memory usage, disk I/O, and network I/O."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {
                "type": "string",
                "description": "Node name where the container resides",
            },
            "ctid": {
                "type": "integer",
                "description": "Container ID number",
                "minimum": 100,
            },
        },
        "required": ["node", "ctid"],
    },
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
    },
)

TOOL_LIST_CONTAINER_SNAPSHOTS = Tool(
    name="list_container_snapshots",
    title="List Container Snapshots",
    description=(
        "List all snapshots for a specific LXC container, including "
        "snapshot name, creation time, and description."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {
                "type": "string",
                "description": "Node name where the container resides",
            },
            "ctid": {
                "type": "integer",
                "description": "Container ID number",
                "minimum": 100,
            },
        },
        "required": ["node", "ctid"],
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

def _list_containers(node: str | None = None) -> list[dict[str, Any]]:
    client = get_client()
    if node:
        raw = client.nodes(node).lxc.get()
        for ct in raw:
            ct["node"] = node
    else:
        resources = client.cluster.resources.get(type="vm")
        raw = [r for r in resources if r.get("type") == "lxc"]

    return [
        {
            "ctid": ct.get("vmid") or ct.get("ctid"),
            "name": ct.get("name", "unnamed"),
            "node": ct.get("node", node or "unknown"),
            "status": ct.get("status"),
            "cpu_usage_pct": round(ct.get("cpu", 0) * 100, 1),
            "memory_used_mb": round(ct.get("mem", 0) / 1024**2, 0),
            "memory_total_mb": round(ct.get("maxmem", 0) / 1024**2, 0),
            "uptime_hours": round(ct.get("uptime", 0) / 3600, 1),
        }
        for ct in raw
    ]


def _get_container(node: str, ctid: int) -> dict[str, Any]:
    client = get_client()
    config = client.nodes(node).lxc(ctid).config.get()

    # Extract network interfaces
    networks = []
    for key, val in config.items():
        if key.startswith("net") and key[3:].isdigit():
            networks.append({"interface": key, "config": val})

    # Extract mount points
    mounts = []
    for key, val in config.items():
        if key.startswith("mp") and key[2:].isdigit():
            mounts.append({"mount": key, "config": val})

    return {
        "ctid": ctid,
        "node": node,
        "hostname": config.get("hostname", "unnamed"),
        "cores": config.get("cores", 1),
        "memory_mb": config.get("memory", 0),
        "swap_mb": config.get("swap", 0),
        "os_template": config.get("ostype", "unknown"),
        "rootfs": config.get("rootfs", ""),
        "onboot": bool(config.get("onboot", 0)),
        "unprivileged": bool(config.get("unprivileged", 0)),
        "description": config.get("description", ""),
        "tags": config.get("tags", ""),
        "networks": networks,
        "mounts": mounts,
    }


def _get_container_status(node: str, ctid: int) -> dict[str, Any]:
    client = get_client()
    s = client.nodes(node).lxc(ctid).status.current.get()
    return {
        "ctid": ctid,
        "node": node,
        "name": s.get("name", "unnamed"),
        "status": s.get("status"),
        "cpu_usage_pct": round(s.get("cpu", 0) * 100, 1),
        "memory_used_mb": round(s.get("mem", 0) / 1024**2, 1),
        "memory_total_mb": round(s.get("maxmem", 0) / 1024**2, 1),
        "disk_read_mb": round(s.get("diskread", 0) / 1024**2, 2),
        "disk_write_mb": round(s.get("diskwrite", 0) / 1024**2, 2),
        "net_in_mb": round(s.get("netin", 0) / 1024**2, 2),
        "net_out_mb": round(s.get("netout", 0) / 1024**2, 2),
        "uptime_hours": round(s.get("uptime", 0) / 3600, 1),
    }


def _list_container_snapshots(node: str, ctid: int) -> list[dict[str, Any]]:
    client = get_client()
    snaps = client.nodes(node).lxc(ctid).snapshot.get()
    return [
        {
            "name": s.get("name"),
            "description": s.get("description", ""),
            "created": s.get("snaptime", ""),
        }
        for s in snaps
        if s.get("name") != "current"
    ]


# ---------------------------------------------------------------------------
# Handler dispatcher
# ---------------------------------------------------------------------------

async def handle(tool_name: str, arguments: dict[str, Any]) -> list[TextContent]:
    try:
        if tool_name == "list_containers":
            node = arguments.get("node", "").strip() or None
            result = _list_containers(node)
            text = _format_container_list(result)

        elif tool_name == "get_container":
            node, ctid = _require_node_ctid(arguments)
            if isinstance(node, list):
                return node
            result = _get_container(node, ctid)
            text = _format_container_detail(result)

        elif tool_name == "get_container_status":
            node, ctid = _require_node_ctid(arguments)
            if isinstance(node, list):
                return node
            result = _get_container_status(node, ctid)
            text = _format_container_status(result)

        elif tool_name == "list_container_snapshots":
            node, ctid = _require_node_ctid(arguments)
            if isinstance(node, list):
                return node
            result = _list_container_snapshots(node, ctid)
            text = _format_snapshots(ctid, result)

        else:
            return [TextContent(type="text", text=f"Unknown tool: {tool_name}")]

    except ProxmoxError as exc:
        logger.error("Proxmox error in %s: %s", tool_name, exc)
        return [TextContent(type="text", text=f"Proxmox error: {exc}")]

    return [TextContent(type="text", text=text)]


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _require_node_ctid(
    arguments: dict[str, Any],
) -> tuple[str, int] | list[TextContent]:
    node = arguments.get("node", "").strip()
    ctid_raw = arguments.get("ctid")
    if not node:
        return [TextContent(type="text", text="Error: 'node' parameter is required.")]
    if ctid_raw is None:
        return [TextContent(type="text", text="Error: 'ctid' parameter is required.")]
    try:
        ctid = int(ctid_raw)
    except (TypeError, ValueError):
        return [TextContent(type="text", text="Error: 'ctid' must be an integer.")]
    if ctid < 100:
        return [TextContent(type="text", text="Error: 'ctid' must be >= 100.")]
    return node, ctid


# ---------------------------------------------------------------------------
# Formatters
# ---------------------------------------------------------------------------

def _format_container_list(containers: list[dict[str, Any]]) -> str:
    if not containers:
        return "No LXC containers found."
    lines = [f"## LXC Containers ({len(containers)} total)\n"]
    for ct in sorted(containers, key=lambda c: int(c.get("ctid") or 0)):
        icon = "🟢" if ct["status"] == "running" else "⚫"
        lines.append(
            f"{icon} **{ct['ctid']} — {ct['name']}** ({ct['node']}) — {ct['status']}\n"
            f"   CPU: {ct['cpu_usage_pct']}%  "
            f"RAM: {ct['memory_used_mb']} / {ct['memory_total_mb']} MB  "
            f"Uptime: {ct['uptime_hours']}h"
        )
    return "\n".join(lines)


def _format_container_detail(ct: dict[str, Any]) -> str:
    net_lines = "\n".join(f"  - {n['interface']}: {n['config']}" for n in ct["networks"])
    mp_lines = "\n".join(f"  - {m['mount']}: {m['config']}" for m in ct["mounts"])
    return (
        f"## Container {ct['ctid']}: {ct['hostname']}\n\n"
        f"**Node:** {ct['node']}\n"
        f"**CPU:** {ct['cores']} core(s)\n"
        f"**Memory:** {ct['memory_mb']} MB\n"
        f"**Swap:** {ct['swap_mb']} MB\n"
        f"**Root FS:** {ct['rootfs']}\n"
        f"**Unprivileged:** {'yes' if ct['unprivileged'] else 'no'}\n"
        f"**Start on Boot:** {'yes' if ct['onboot'] else 'no'}\n"
        f"**Tags:** {ct['tags'] or 'none'}\n"
        f"**Networks:**\n{net_lines or '  none'}\n"
        f"**Mounts:**\n{mp_lines or '  none'}\n"
        f"**Description:** {ct['description'] or 'none'}\n"
    )


def _format_container_status(s: dict[str, Any]) -> str:
    icon = "🟢" if s["status"] == "running" else "⚫"
    return (
        f"## Container {s['ctid']} Status: {s['name']}\n\n"
        f"{icon} **State:** {s['status']}\n"
        f"**CPU:** {s['cpu_usage_pct']}%\n"
        f"**Memory:** {s['memory_used_mb']} / {s['memory_total_mb']} MB\n"
        f"**Disk I/O:** ↑ {s['disk_write_mb']} MB written, ↓ {s['disk_read_mb']} MB read\n"
        f"**Network:** ↑ {s['net_out_mb']} MB out, ↓ {s['net_in_mb']} MB in\n"
        f"**Uptime:** {s['uptime_hours']} hours\n"
    )


def _format_snapshots(ctid: int, snaps: list[dict[str, Any]]) -> str:
    if not snaps:
        return f"No snapshots found for container {ctid}."
    lines = [f"## Snapshots for Container {ctid}\n"]
    for s in snaps:
        lines.append(
            f"📸 **{s['name']}**"
            + (f" — {s['description']}" if s["description"] else "")
        )
    return "\n".join(lines)
