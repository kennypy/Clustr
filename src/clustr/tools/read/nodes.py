"""
Read-only tools for Proxmox node information.

All tools in this module are registered with:
    readOnlyHint = True
    destructiveHint = False

These tools never mutate any state on the Proxmox cluster.
"""

from __future__ import annotations

import logging
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from clustr.proxmox.client import get_client, proxmox_get
from clustr.tools import safe

logger = logging.getLogger(__name__)

_READ_ONLY = ToolAnnotations(
    readOnlyHint=True, destructiveHint=False, idempotentHint=True
)


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------


def _list_nodes() -> list[dict[str, Any]]:
    nodes = proxmox_get(lambda: get_client().nodes.get())
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
    status = proxmox_get(lambda: get_client().nodes(node).status.get())
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
    services = proxmox_get(lambda: get_client().nodes(node).services.get())
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
    cluster = proxmox_get(lambda: get_client().cluster.status.get())
    resources = proxmox_get(lambda: get_client().cluster.resources.get())

    nodes_online = sum(
        1 for item in cluster if item.get("type") == "node" and item.get("online")
    )
    nodes_total = sum(1 for item in cluster if item.get("type") == "node")
    quorum: dict[str, Any] = next(
        (item for item in cluster if item.get("type") == "cluster"), {}
    )

    vms_running = sum(
        1 for r in resources if r.get("type") == "qemu" and r.get("status") == "running"
    )
    vms_total = sum(1 for r in resources if r.get("type") == "qemu")
    cts_running = sum(
        1 for r in resources if r.get("type") == "lxc" and r.get("status") == "running"
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
# Tool registration
# ---------------------------------------------------------------------------


def register(mcp: FastMCP) -> None:
    """Register all node read tools onto the given FastMCP instance."""

    @mcp.tool(
        name="list_nodes",
        title="List Nodes",
        description=(
            "List all nodes in the Proxmox cluster with their status, CPU, "
            "memory usage, and uptime. Use this to get an overview of cluster "
            "health before drilling into individual nodes or VMs."
        ),
        annotations=_READ_ONLY,
    )
    def list_nodes() -> str:
        return safe("list_nodes", lambda: _format_nodes(_list_nodes()))

    @mcp.tool(
        name="get_node",
        title="Get Node Details",
        description=(
            "Get detailed status for a specific Proxmox node including CPU "
            "usage, memory, disk, network interfaces, and running services. "
            "Requires the node name (e.g. 'pve')."
        ),
        annotations=_READ_ONLY,
    )
    def get_node(node: str) -> str:
        return safe("get_node", lambda: _format_node_detail(_get_node(node)))

    @mcp.tool(
        name="get_node_services",
        title="Get Node Services",
        description=(
            "List all system services on a Proxmox node with their running state. "
            "Useful for checking if pve-cluster, corosync, or other critical "
            "services are running."
        ),
        annotations=_READ_ONLY,
    )
    def get_node_services(node: str) -> str:
        return safe(
            "get_node_services",
            lambda: _format_services(node, _get_node_services(node)),
        )

    @mcp.tool(
        name="get_cluster_status",
        title="Get Cluster Status",
        description=(
            "Get overall Proxmox cluster health: quorum status, node count, "
            "HA state, and resource summary across all nodes. Good starting "
            "point for any infrastructure check."
        ),
        annotations=_READ_ONLY,
    )
    def get_cluster_status() -> str:
        return safe(
            "get_cluster_status", lambda: _format_cluster(_get_cluster_status())
        )


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
        f"**CPU:** {n['cpu_usage_pct']}% used | {n['cpu_cores']} cores | "
        f"{n['cpu_model']}\n"
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
        f"**Containers:** {c['containers_running']} running / "
        f"{c['containers_total']} total\n"
    )
