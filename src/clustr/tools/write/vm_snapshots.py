"""
Write tools for QEMU VM snapshot management.

Annotations:
  - create_vm_snapshot:   destructiveHint = False
  - delete_vm_snapshot:   destructiveHint = True
  - rollback_vm_snapshot: destructiveHint = True  (replaces current state)
"""
from __future__ import annotations

import logging
from typing import Any

from mcp.types import TextContent, Tool

from clustr.proxmox.client import ProxmoxError, get_client

logger = logging.getLogger(__name__)

# Snapshot name validation: alphanumeric + hyphens/underscores, max 40 chars
import re
_SNAP_NAME_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,40}$")


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

TOOL_CREATE_VM_SNAPSHOT = Tool(
    name="create_vm_snapshot",
    title="Create VM Snapshot",
    description=(
        "Create a snapshot of a QEMU virtual machine. "
        "Snapshot names must be alphanumeric with hyphens/underscores, max 40 chars. "
        "Optionally include RAM state (VM must be running)."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Node name"},
            "vmid": {"type": "integer", "description": "VM ID", "minimum": 100},
            "snapname": {
                "type": "string",
                "description": "Snapshot name (alphanumeric, hyphens, underscores; max 40 chars)",
            },
            "description": {
                "type": "string",
                "description": "Optional description for the snapshot",
                "default": "",
            },
            "include_ram": {
                "type": "boolean",
                "description": "Include RAM state in snapshot (VM must be running). Default false.",
                "default": False,
            },
        },
        "required": ["node", "vmid", "snapname"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": False,
    },
)

TOOL_DELETE_VM_SNAPSHOT = Tool(
    name="delete_vm_snapshot",
    title="Delete VM Snapshot",
    description=(
        "Permanently delete a snapshot of a QEMU virtual machine. "
        "This action cannot be undone."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Node name"},
            "vmid": {"type": "integer", "description": "VM ID", "minimum": 100},
            "snapname": {
                "type": "string",
                "description": "Exact snapshot name to delete",
            },
        },
        "required": ["node", "vmid", "snapname"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": True,
    },
)

TOOL_ROLLBACK_VM_SNAPSHOT = Tool(
    name="rollback_vm_snapshot",
    title="Rollback VM to Snapshot",
    description=(
        "Rollback a QEMU virtual machine to a previous snapshot state. "
        "WARNING: All changes made after the snapshot was taken will be lost. "
        "The VM must be stopped before rolling back."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Node name"},
            "vmid": {"type": "integer", "description": "VM ID", "minimum": 100},
            "snapname": {
                "type": "string",
                "description": "Snapshot name to roll back to",
            },
        },
        "required": ["node", "vmid", "snapname"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": True,
    },
)


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def _create_vm_snapshot(
    node: str,
    vmid: int,
    snapname: str,
    description: str = "",
    include_ram: bool = False,
) -> str:
    client = get_client()
    params: dict[str, Any] = {"snapname": snapname}
    if description:
        params["description"] = description
    if include_ram:
        params["vmstate"] = 1
    return client.nodes(node).qemu(vmid).snapshot.post(**params)


def _delete_vm_snapshot(node: str, vmid: int, snapname: str) -> str:
    client = get_client()
    return client.nodes(node).qemu(vmid).snapshot(snapname).delete()


def _rollback_vm_snapshot(node: str, vmid: int, snapname: str) -> str:
    client = get_client()
    return client.nodes(node).qemu(vmid).snapshot(snapname).rollback.post()


# ---------------------------------------------------------------------------
# Handler dispatcher
# ---------------------------------------------------------------------------

async def handle(tool_name: str, arguments: dict[str, Any]) -> list[TextContent]:
    node = arguments.get("node", "").strip()
    vmid_raw = arguments.get("vmid")
    snapname = arguments.get("snapname", "").strip()

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
    if not snapname:
        return [TextContent(type="text", text="Error: 'snapname' parameter is required.")]

    try:
        if tool_name == "create_vm_snapshot":
            if not _SNAP_NAME_RE.match(snapname):
                return [
                    TextContent(
                        type="text",
                        text=(
                            "Error: Snapshot name must be alphanumeric with "
                            "hyphens/underscores only, max 40 characters."
                        ),
                    )
                ]
            description = arguments.get("description", "")
            include_ram = bool(arguments.get("include_ram", False))
            task_id = _create_vm_snapshot(node, vmid, snapname, description, include_ram)
            return [
                TextContent(
                    type="text",
                    text=(
                        f"✅ Snapshot **{snapname}** creation started for VM {vmid} on {node}.\n"
                        f"Task ID: `{task_id}`\n\n"
                        f"Use `list_vm_snapshots` to confirm when complete."
                    ),
                )
            ]

        elif tool_name == "delete_vm_snapshot":
            task_id = _delete_vm_snapshot(node, vmid, snapname)
            return [
                TextContent(
                    type="text",
                    text=(
                        f"✅ Snapshot **{snapname}** deletion started for VM {vmid} on {node}.\n"
                        f"Task ID: `{task_id}`"
                    ),
                )
            ]

        elif tool_name == "rollback_vm_snapshot":
            task_id = _rollback_vm_snapshot(node, vmid, snapname)
            return [
                TextContent(
                    type="text",
                    text=(
                        f"✅ Rollback to snapshot **{snapname}** started for VM {vmid} on {node}.\n"
                        f"Task ID: `{task_id}`\n\n"
                        f"⚠️ All changes after this snapshot was taken have been discarded."
                    ),
                )
            ]

        else:
            return [TextContent(type="text", text=f"Unknown tool: {tool_name}")]

    except ProxmoxError as exc:
        logger.error("Proxmox error in %s: %s", tool_name, exc)
        return [TextContent(type="text", text=f"Proxmox error: {exc}")]
