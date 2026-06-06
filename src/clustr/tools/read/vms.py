"""
Read-only tools for QEMU virtual machine information.

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


def _list_vms(node: str | None = None) -> list[dict[str, Any]]:
    if node:
        raw = proxmox_get(lambda: get_client().nodes(node).qemu.get())
        for vm in raw:
            vm["node"] = node
    else:
        resources = proxmox_get(lambda: get_client().cluster.resources.get(type="vm"))
        raw = [r for r in resources if r.get("type") == "qemu"]
        for vm in raw:
            # cluster resources use 'name' not 'vmid' in same field
            if "vmid" not in vm and "id" in vm:
                vm["vmid"] = vm["id"].split("/")[-1]

    return [
        {
            "vmid": vm.get("vmid"),
            "name": vm.get("name", "unnamed"),
            "node": vm.get("node", node or "unknown"),
            "status": vm.get("status"),
            "cpu_usage_pct": round(vm.get("cpu", 0) * 100, 1),
            "memory_used_mb": round(vm.get("mem", 0) / 1024**2, 0),
            "memory_total_mb": round(vm.get("maxmem", 0) / 1024**2, 0),
            "uptime_hours": round(vm.get("uptime", 0) / 3600, 1),
        }
        for vm in raw
    ]


def _get_vm(node: str, vmid: int) -> dict[str, Any]:
    config = proxmox_get(lambda: get_client().nodes(node).qemu(vmid).config.get())
    return {
        "vmid": vmid,
        "node": node,
        "name": config.get("name", "unnamed"),
        "cores": config.get("cores", 1),
        "sockets": config.get("sockets", 1),
        "memory_mb": config.get("memory", 0),
        "os_type": config.get("ostype", "unknown"),
        "boot_order": config.get("boot", ""),
        "agent_enabled": bool(config.get("agent", 0)),
        "description": config.get("description", ""),
        "tags": config.get("tags", ""),
        "onboot": bool(config.get("onboot", 0)),
    }


def _get_vm_status(node: str, vmid: int) -> dict[str, Any]:
    s = proxmox_get(lambda: get_client().nodes(node).qemu(vmid).status.current.get())
    return {
        "vmid": vmid,
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
        "qemu_status": s.get("qmpstatus", "unknown"),
    }


def _list_vm_snapshots(node: str, vmid: int) -> list[dict[str, Any]]:
    snaps = proxmox_get(lambda: get_client().nodes(node).qemu(vmid).snapshot.get())
    return [
        {
            "name": s.get("name"),
            "description": s.get("description", ""),
            "created": s.get("snaptime", ""),
            "vmstate": bool(s.get("vmstate", 0)),
            "is_current": s.get("name") == "current",
        }
        for s in snaps
        if s.get("name") != "current"
    ]


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------


def register(mcp: FastMCP) -> None:
    """Register all VM read tools onto the given FastMCP instance."""

    @mcp.tool(
        name="list_vms",
        title="List Virtual Machines",
        description=(
            "List all QEMU virtual machines across all nodes, showing VM ID, "
            "name, status, CPU, and memory. Optionally filter by node name."
        ),
        annotations=_READ_ONLY,
    )
    async def list_vms(
        node: Annotated[
            str,
            Field(
                description="Filter to a specific node name (optional). "
                "Omit to list VMs across all nodes."
            ),
        ] = "",
    ) -> str:
        return await safe(
            "list_vms", lambda: _format_vm_list(_list_vms(node.strip() or None))
        )

    @mcp.tool(
        name="get_vm",
        title="Get VM Details",
        description=(
            "Get detailed configuration and runtime status for a specific "
            "QEMU virtual machine by node name and VM ID."
        ),
        annotations=_READ_ONLY,
    )
    async def get_vm(
        node: Annotated[
            str, Field(description="Node name where the VM resides (e.g. 'pve')")
        ],
        vmid: Annotated[int, Field(ge=100, description="VM ID number (e.g. 100)")],
    ) -> str:
        return await safe("get_vm", lambda: _format_vm_detail(_get_vm(node, vmid)))

    @mcp.tool(
        name="get_vm_status",
        title="Get VM Status",
        description=(
            "Get current runtime status for a VM: power state, CPU usage, "
            "memory usage, disk I/O, and network I/O."
        ),
        annotations=_READ_ONLY,
    )
    async def get_vm_status(
        node: Annotated[str, Field(description="Node name where the VM resides")],
        vmid: Annotated[int, Field(ge=100, description="VM ID number")],
    ) -> str:
        return await safe(
            "get_vm_status", lambda: _format_vm_status(_get_vm_status(node, vmid))
        )

    @mcp.tool(
        name="list_vm_snapshots",
        title="List VM Snapshots",
        description=(
            "List all snapshots for a QEMU virtual machine, including snapshot "
            "name, creation time, and description."
        ),
        annotations=_READ_ONLY,
    )
    async def list_vm_snapshots(
        node: Annotated[str, Field(description="Node name where the VM resides")],
        vmid: Annotated[int, Field(ge=100, description="VM ID number")],
    ) -> str:
        return await safe(
            "list_vm_snapshots",
            lambda: _format_snapshots("VM", vmid, _list_vm_snapshots(node, vmid)),
        )


# ---------------------------------------------------------------------------
# Formatters
# ---------------------------------------------------------------------------


def _format_vm_list(vms: list[dict[str, Any]]) -> str:
    if not vms:
        return "No virtual machines found."
    lines = [f"## Virtual Machines ({len(vms)} total)\n"]
    for vm in sorted(vms, key=lambda v: int(v.get("vmid") or 0)):
        icon = "🟢" if vm["status"] == "running" else "⚫"
        lines.append(
            f"{icon} **{vm['vmid']} — {vm['name']}** ({vm['node']}) — {vm['status']}\n"
            f"   CPU: {vm['cpu_usage_pct']}%  "
            f"RAM: {vm['memory_used_mb']} / {vm['memory_total_mb']} MB  "
            f"Uptime: {vm['uptime_hours']}h"
        )
    return "\n".join(lines)


def _format_vm_detail(vm: dict[str, Any]) -> str:
    return (
        f"## VM {vm['vmid']}: {vm['name']}\n\n"
        f"**Node:** {vm['node']}\n"
        f"**CPU:** {vm['cores']} cores × {vm['sockets']} socket(s)\n"
        f"**Memory:** {vm['memory_mb']} MB\n"
        f"**OS Type:** {vm['os_type']}\n"
        f"**Boot Order:** {vm['boot_order']}\n"
        f"**QEMU Agent:** {'enabled' if vm['agent_enabled'] else 'disabled'}\n"
        f"**Start on Boot:** {'yes' if vm['onboot'] else 'no'}\n"
        f"**Tags:** {vm['tags'] or 'none'}\n"
        f"**Description:** {vm['description'] or 'none'}\n"
    )


def _format_vm_status(s: dict[str, Any]) -> str:
    icon = "🟢" if s["status"] == "running" else "⚫"
    return (
        f"## VM {s['vmid']} Status: {s['name']}\n\n"
        f"{icon} **State:** {s['status']} ({s['qemu_status']})\n"
        f"**CPU:** {s['cpu_usage_pct']}%\n"
        f"**Memory:** {s['memory_used_mb']} / {s['memory_total_mb']} MB\n"
        f"**Disk I/O:** ↑ {s['disk_write_mb']} MB written, "
        f"↓ {s['disk_read_mb']} MB read\n"
        f"**Network:** ↑ {s['net_out_mb']} MB out, ↓ {s['net_in_mb']} MB in\n"
        f"**Uptime:** {s['uptime_hours']} hours\n"
    )


def _format_snapshots(kind: str, vmid: int, snaps: list[dict[str, Any]]) -> str:
    if not snaps:
        return f"No snapshots found for {kind} {vmid}."
    lines = [f"## Snapshots for {kind} {vmid}\n"]
    for s in snaps:
        lines.append(
            f"📸 **{s['name']}**"
            + (f" — {s['description']}" if s["description"] else "")
            + (" (includes RAM state)" if s["vmstate"] else "")
        )
    return "\n".join(lines)
