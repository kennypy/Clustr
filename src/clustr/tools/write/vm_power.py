"""
Write tools for QEMU VM power management.

start / stop / reboot / shutdown are separate tools as required by
Anthropic review criteria — no catch-all method parameter.

Annotations:
  - start:    destructiveHint = False  (non-destructive state change)
  - stop:     destructiveHint = True   (force-stops without graceful shutdown)
  - shutdown: destructiveHint = False  (graceful, guest-initiated)
  - reboot:   destructiveHint = False  (graceful restart)
  - reset:    destructiveHint = True   (hard reset, equivalent to power cycle)
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

TOOL_START_VM = Tool(
    name="start_vm",
    title="Start VM",
    description=(
        "Start a stopped QEMU virtual machine. "
        "Has no effect if the VM is already running."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Node name (e.g. 'pve')"},
            "vmid": {"type": "integer", "description": "VM ID", "minimum": 100},
        },
        "required": ["node", "vmid"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": False,
    },
)

TOOL_SHUTDOWN_VM = Tool(
    name="shutdown_vm",
    title="Shutdown VM (Graceful)",
    description=(
        "Send a graceful shutdown signal to a QEMU virtual machine via ACPI. "
        "The guest OS handles the shutdown. Use stop_vm if the guest is "
        "unresponsive."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Node name"},
            "vmid": {"type": "integer", "description": "VM ID", "minimum": 100},
        },
        "required": ["node", "vmid"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": False,
    },
)

TOOL_STOP_VM = Tool(
    name="stop_vm",
    title="Stop VM (Force)",
    description=(
        "Force-stop a QEMU virtual machine immediately, equivalent to pulling "
        "the power cable. Data loss may occur. Prefer shutdown_vm for a "
        "graceful stop unless the guest is unresponsive."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Node name"},
            "vmid": {"type": "integer", "description": "VM ID", "minimum": 100},
        },
        "required": ["node", "vmid"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": True,
    },
)

TOOL_REBOOT_VM = Tool(
    name="reboot_vm",
    title="Reboot VM (Graceful)",
    description=(
        "Send a graceful reboot signal to a running QEMU virtual machine "
        "via ACPI. The guest OS handles the restart."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Node name"},
            "vmid": {"type": "integer", "description": "VM ID", "minimum": 100},
        },
        "required": ["node", "vmid"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": False,
    },
)

TOOL_RESET_VM = Tool(
    name="reset_vm",
    title="Reset VM (Hard Reset)",
    description=(
        "Hard-reset a QEMU virtual machine, equivalent to pressing the "
        "physical reset button. Data loss may occur. "
        "Prefer reboot_vm for a graceful restart."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Node name"},
            "vmid": {"type": "integer", "description": "VM ID", "minimum": 100},
        },
        "required": ["node", "vmid"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": True,
    },
)


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def _vm_power_action(node: str, vmid: int, action: str) -> str:
    """Execute a power action on a VM and return a task ID."""
    client = get_client()
    vm_api = client.nodes(node).qemu(vmid)
    action_map = {
        "start": vm_api.status.start.post,
        "shutdown": vm_api.status.shutdown.post,
        "stop": vm_api.status.stop.post,
        "reboot": vm_api.status.reboot.post,
        "reset": vm_api.status.reset.post,
    }
    fn = action_map.get(action)
    if fn is None:
        raise ProxmoxError(f"Unknown power action: {action}")
    task_id = fn()
    return task_id


# ---------------------------------------------------------------------------
# Handler dispatcher
# ---------------------------------------------------------------------------

async def handle(tool_name: str, arguments: dict[str, Any]) -> list[TextContent]:
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

    action_map = {
        "start_vm": "start",
        "shutdown_vm": "shutdown",
        "stop_vm": "stop",
        "reboot_vm": "reboot",
        "reset_vm": "reset",
    }

    action = action_map.get(tool_name)
    if action is None:
        return [TextContent(type="text", text=f"Unknown tool: {tool_name}")]

    try:
        task_id = _vm_power_action(node, vmid, action)
        return [
            TextContent(
                type="text",
                text=(
                    f"✅ VM {vmid} on {node}: **{action}** initiated.\n"
                    f"Task ID: `{task_id}`\n\n"
                    f"Use `get_vm_status` to check the current state."
                ),
            )
        ]
    except ProxmoxError as exc:
        logger.error("Proxmox error in %s: %s", tool_name, exc)
        return [TextContent(type="text", text=f"Proxmox error: {exc}")]
