"""
Read-only tools for Proxmox node information.

All tools in this module are registered with:
    readOnlyHint = True
    destructiveHint = False (implicit)

These tools never mutate any state on the Proxmox cluster.
"""
from __future__ import annotations

import logging
from typing import Any

from mcp.server import Server
from mcp.types import TextContent, Tool

from clustr.proxmox.client import ProxmoxError, get_client

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

TOOL_LIST_NODES = Tool(
    name="list_nodes",
    title="List Nodes",
    description=(
        "List all nodes in the Proxmox cluster with their status, CPU, "
        "memory usage, and uptime. Use this to get an overview of cluster "
        "health before drilling into individual nodes or VMs."
    ),
    inputSchema={
        "type": "object",
        "properties": {},
        "required": [],
    },
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
    },
)

TOOL_GET_NODE = Tool(
    name="get_node",
    title="Get Node Details",
    description=(
        "Get detailed status for a specific Proxmox node including CPU "
        "usage, memory, disk, network interfaces, and running services. "
        "Requires the node name (e.g. 'pve')."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {
                "type": "string",
                "description": "Node name as shown in Proxmox UI (e.g. 'pve')",
            }
        },
        "required": ["node"],
    },
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
    },
)

TOOL_GET_NODE_SERVICES = Tool(
    name="get_node_services",
    title="Get Node Services",
    description=(
        "List all system services on a Proxmox node with their running state. "
        "Useful for checking if pve-cluster, corosync, or other critical "
        "services are running."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {
                "type": "string",
                "description": "Node name (e.g. 'pve')",
            }
        },
        "required": ["node"],
    },
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
    },
)

TOOL_GET_CLUSTER_STATUS = Tool(
    name="get_cluster_status",
    title="Get Cluster Status",
    description=(
        "Get overall Proxmox cluster health: quorum status, node count, "
        "HA state, and resource summary across all nodes. Good starting "
        "point for any infrastructure check."
    ),
    inputSchema={
        "type": "object",
        "properties": {},
        "required": [],
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

def _list_nodes() -> list[dict[str, Any]]:
    client = get_client()
    nodes = client.nodes.get()
    return [
        {
            "name": n.get("node"),
            "status": n.get("status"),
            "cpu_usage_pct": round(n.get("cpu", 0) * 100, 1),
            "memory_used_gb": round(n.get("mem", 0) / 1024**3, 2),
            "memory_total_gb": round(n.get("maxmem", 0) / 1024**3, 2),
            "uptime_hours": round(n.get("uptime", 0) / 3600, 1),
            "type": n.get("type"),
        }
        for n in nodes
    ]


def _get_node(node: str) -> dict[str, Any]:
    client = get_client()
    status = client.nodes(node).status.get()
    return {
        "node": node,
        "cpu_usage_pct": round(status.get("cpu", 0) * 100, 1),
        "cpu_cores": status.get("cpuinfo", {}).get("cores", "unknown"),
        "cpu_model": status.get("cpuinfo", {}).get("model", "unknown"),
        "memory_used_gb": round(status.get("memory", {}).get("used", 0) / 1024**3, 2),
        "memory_total_gb": round(status.get("memory", {}).get("total", 0) / 1024**3, 2),
        "disk_used_gb": round(status.get("rootfs", {}).get("used", 0) / 1024**3, 2),
        "disk_total_gb": round(status.get("rootfs", {}).get("total", 0) / 1024**3, 2),
        "uptime_hours": round(status.get("uptime", 0) / 3600, 1),
        "kernel_version": status.get("kversion", "unknown"),
        "pve_version": status.get("pveversion", "unknown"),
    }


def _get_node_services(node: str) -> list[dict[str, Any]]:
    client = get_client()
    services = client.nodes(node).services.get()
    return [
        {
            "name": s.get("name"),
            "description": s.get("desc", ""),
            "state": s.get("state"),
            "active": s.get("active-state", "unknown"),
        }
        for s in services
    ]


def _get_cluster_status() -> dict[str, Any]:
    client = get_client()
    cluster = client.cluster.status.get()
    resources = client.cluster.resources.get()

    nodes_online = sum(1 for item in cluster if item.get("type") == "node" and item.get("online"))
    nodes_total = sum(1 for item in cluster if item.get("type") == "node")
    quorum = next(
        (item for item in cluster if item.get("type") == "cluster"), {}
    )

    vms_running = sum(
        1
        for r in resources
        if r.get("type") == "qemu" and r.get("status") == "running"
    )
    vms_total = sum(1 for r in resources if r.get("type") == "qemu")
    cts_running = sum(
        1
        for r in resources
        if r.get("type") == "lxc" and r.get("status") == "running"
    )
    cts_total = sum(1 for r in resources if r.get("type") == "lxc")

    return {
        "cluster_name": quorum.get("name", "unknown"),
        "quorum": quorum.get("quorate", 0),
        "nodes_online": nodes_online,
        "nodes_total": nodes_total,
        "vms_running": vms_running,
        "vms_total": vms_total,
        "containers_running": cts_running,
        "containers_total": cts_total,
    }


# ---------------------------------------------------------------------------
# Handler dispatcher
# ---------------------------------------------------------------------------

async def handle(tool_name: str, arguments: dict[str, Any]) -> list[TextContent]:
    """Route a tool call to the correct implementation."""
    try:
        if tool_name == "list_nodes":
            result = _list_nodes()
            text = _format_nodes(result)

        elif tool_name == "get_node":
            node = arguments.get("node", "").strip()
            if not node:
                return [TextContent(type="text", text="Error: 'node' parameter is required.")]
            result = _get_node(node)
            text = _format_node_detail(result)

        elif tool_name == "get_node_services":
            node = arguments.get("node", "").strip()
            if not node:
                return [TextContent(type="text", text="Error: 'node' parameter is required.")]
            result = _get_node_services(node)
            text = _format_services(node, result)

        elif tool_name == "get_cluster_status":
            result = _get_cluster_status()
            text = _format_cluster(result)

        else:
            return [TextContent(type="text", text=f"Unknown tool: {tool_name}")]

    except ProxmoxError as exc:
        logger.error("Proxmox error in %s: %s", tool_name, exc)
        return [TextContent(type="text", text=f"Proxmox error: {exc}")]

    return [TextContent(type="text", text=text)]


# ---------------------------------------------------------------------------
# Formatters
# ---------------------------------------------------------------------------

def _format_nodes(nodes: list[dict[str, Any]]) -> str:
    if not nodes:
        return "No nodes found in cluster."
    lines = ["## Cluster Nodes\n"]
    for n in nodes:
        status_icon = "🟢" if n["status"] == "online" else "🔴"
        lines.append(
            f"{status_icon} **{n['name']}** — {n['status']}\n"
            f"   CPU: {n['cpu_usage_pct']}%  "
            f"RAM: {n['memory_used_gb']} / {n['memory_total_gb']} GB  "
            f"Uptime: {n['uptime_hours']}h\n"
        )
    return "\n".join(lines)


def _format_node_detail(n: dict[str, Any]) -> str:
    return (
        f"## Node: {n['node']}\n\n"
        f"**CPU:** {n['cpu_usage_pct']}% used | {n['cpu_cores']} cores | {n['cpu_model']}\n"
        f"**Memory:** {n['memory_used_gb']} / {n['memory_total_gb']} GB\n"
        f"**Disk (root):** {n['disk_used_gb']} / {n['disk_total_gb']} GB\n"
        f"**Uptime:** {n['uptime_hours']} hours\n"
        f"**Kernel:** {n['kernel_version']}\n"
        f"**PVE:** {n['pve_version']}\n"
    )


def _format_services(node: str, services: list[dict[str, Any]]) -> str:
    if not services:
        return f"No services found on node '{node}'."
    lines = [f"## Services on {node}\n"]
    for s in services:
        icon = "🟢" if s["state"] == "running" else "🔴"
        lines.append(f"{icon} **{s['name']}** — {s['state']} ({s['description']})")
    return "\n".join(lines)


def _format_cluster(c: dict[str, Any]) -> str:
    quorum_icon = "✅" if c["quorum"] else "❌"
    return (
        f"## Cluster: {c['cluster_name']}\n\n"
        f"**Quorum:** {quorum_icon}\n"
        f"**Nodes:** {c['nodes_online']} / {c['nodes_total']} online\n"
        f"**VMs:** {c['vms_running']} running / {c['vms_total']} total\n"
        f"**Containers:** {c['containers_running']} running / {c['containers_total']} total\n"
    )
