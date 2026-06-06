"""
Read-only tools for QEMU virtual machine information.

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

TOOL_LIST_VMS = Tool(
    name="list_vms",
    title="List Virtual Machines",
    description=(
        "List all QEMU virtual machines across all nodes, showing VM ID, "
        "name, status, CPU, and memory. Optionally filter by node name."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {
                "type": "string",
                "description": "Filter to a specific node name (optional). "
                               "Omit to list VMs across all nodes.",
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

TOOL_GET_VM = Tool(
    name="get_vm",
    title="Get VM Details",
    description=(
        "Get detailed configuration and runtime status for a specific "
        "QEMU virtual machine by node name and VM ID."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {
                "type": "string",
                "description": "Node name where the VM resides (e.g. 'pve')",
            },
            "vmid": {
                "type": "integer",
                "description": "VM ID number (e.g. 100)",
                "minimum": 100,
            },
        },
        "required": ["node", "vmid"],
    },
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
    },
)

TOOL_GET_VM_STATUS = Tool(
    name="get_vm_status",
    title="Get VM Status",
    description=(
        "Get current runtime status for a VM: power state, CPU usage, "
        "memory usage, disk I/O, and network I/O."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {
                "type": "string",
                "description": "Node name where the VM resides",
            },
            "vmid": {
                "type": "integer",
                "description": "VM ID number",
                "minimum": 100,
            },
        },
        "required": ["node", "vmid"],
    },
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
    },
)

TOOL_LIST_VM_SNAPSHOTS = Tool(
    name="list_vm_snapshots",
    title="List VM Snapshots",
    description=(
        "List all snapshots for a QEMU virtual machine, including snapshot "
        "name, creation time, and description."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {
                "type": "string",
                "description": "Node name where the VM resides",
            },
            "vmid": {
                "type": "integer",
                "description": "VM ID number",
                "minimum": 100,
            },
        },
        "required": ["node", "vmid"],
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

def _list_vms(node: str | None = None) -> list[dict[str, Any]]:
    client = get_client()
    if node:
        raw = client.nodes(node).qemu.get()
        for vm in raw:
            vm["node"] = node
    else:
        resources = client.cluster.resources.get(type="vm")
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
    client = get_client()
    config = client.nodes(node).qemu(vmid).config.get()
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
    client = get_client()
    s = client.nodes(node).qemu(vmid).status.current.get()
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
    client = get_client()
    snaps = client.nodes(node).qemu(vmid).snapshot.get()
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
# Handler dispatcher
# ---------------------------------------------------------------------------

async def handle(tool_name: str, arguments: dict[str, Any]) -> list[TextContent]:
    try:
        if tool_name == "list_vms":
            node = arguments.get("node", "").strip() or None
            result = _list_vms(node)
            text = _format_vm_list(result)

        elif tool_name == "get_vm":
            node, vmid = _require_node_vmid(arguments)
            if isinstance(node, list):
                return node  # validation error returned as TextContent list
            result = _get_vm(node, vmid)
            text = _format_vm_detail(result)

        elif tool_name == "get_vm_status":
            node, vmid = _require_node_vmid(arguments)
            if isinstance(node, list):
                return node
            result = _get_vm_status(node, vmid)
            text = _format_vm_status(result)

        elif tool_name == "list_vm_snapshots":
            node, vmid = _require_node_vmid(arguments)
            if isinstance(node, list):
                return node
            result = _list_vm_snapshots(node, vmid)
            text = _format_snapshots("VM", vmid, result)

        else:
            return [TextContent(type="text", text=f"Unknown tool: {tool_name}")]

    except ProxmoxError as exc:
        logger.error("Proxmox error in %s: %s", tool_name, exc)
        return [TextContent(type="text", text=f"Proxmox error: {exc}")]

    return [TextContent(type="text", text=text)]


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _require_node_vmid(
    arguments: dict[str, Any],
) -> tuple[str, int] | list[TextContent]:
    node = arguments.get("node", "").strip()
    vmid_raw = arguments.get("vmid")
    if not node:
        return [TextContent(type="text", text="Error: 'node' parameter is required.")]
    if vmid_raw is None:
        return [TextContent(type="text", text="Error: 'vmid' parameter is required.")]
    try:
        vmid = int(vmid_raw)
    except (TypeError, ValueError):
        return [TextContent(type="text", text="Error: 'vmid' must be an integer.")]
    if vmid < 100:
        return [TextContent(type="text", text="Error: 'vmid' must be >= 100.")]
    return node, vmid


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
        f"**Disk I/O:** ↑ {s['disk_write_mb']} MB written, ↓ {s['disk_read_mb']} MB read\n"
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
            + (f" (includes RAM state)" if s["vmstate"] else "")
        )
    return "\n".join(lines)
