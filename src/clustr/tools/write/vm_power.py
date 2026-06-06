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
from typing import Annotated

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from clustr.proxmox.client import ProxmoxError, get_client, proxmox_post
from clustr.tools import safe

logger = logging.getLogger(__name__)

_SAFE_WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False)
_DESTRUCTIVE = ToolAnnotations(readOnlyHint=False, destructiveHint=True)

_Node = Annotated[str, Field(description="Node name (e.g. 'pve')")]
_VmId = Annotated[int, Field(ge=100, description="VM ID")]


# ---------------------------------------------------------------------------
# Tool implementation
# ---------------------------------------------------------------------------

def _vm_power_action(node: str, vmid: int, action: str) -> str:
    """Execute a power action on a VM and return a task ID."""
    actions = {"start", "shutdown", "stop", "reboot", "reset"}
    if action not in actions:
        raise ProxmoxError(f"Unknown power action: {action}")
    return proxmox_post(
        lambda: getattr(get_client().nodes(node).qemu(vmid).status, action).post()
    )


def _run(node: str, vmid: int, action: str) -> str:
    task_id = _vm_power_action(node, vmid, action)
    return (
        f"✅ VM {vmid} on {node}: **{action}** initiated.\n"
        f"Task ID: `{task_id}`\n\n"
        f"Use `get_vm_status` to check the current state."
    )


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------

def register(mcp: FastMCP) -> None:
    """Register all VM power tools onto the given FastMCP instance."""

    @mcp.tool(
        name="start_vm",
        title="Start VM",
        description=(
            "Start a stopped QEMU virtual machine. "
            "Has no effect if the VM is already running."
        ),
        annotations=_SAFE_WRITE,
    )
    def start_vm(node: _Node, vmid: _VmId) -> str:
        return safe("start_vm", lambda: _run(node, vmid, "start"))

    @mcp.tool(
        name="shutdown_vm",
        title="Shutdown VM (Graceful)",
        description=(
            "Send a graceful shutdown signal to a QEMU virtual machine via ACPI. "
            "The guest OS handles the shutdown. Use stop_vm if the guest is "
            "unresponsive."
        ),
        annotations=_SAFE_WRITE,
    )
    def shutdown_vm(node: _Node, vmid: _VmId) -> str:
        return safe("shutdown_vm", lambda: _run(node, vmid, "shutdown"))

    @mcp.tool(
        name="stop_vm",
        title="Stop VM (Force)",
        description=(
            "Force-stop a QEMU virtual machine immediately, equivalent to pulling "
            "the power cable. Data loss may occur. Prefer shutdown_vm for a "
            "graceful stop unless the guest is unresponsive."
        ),
        annotations=_DESTRUCTIVE,
    )
    def stop_vm(node: _Node, vmid: _VmId) -> str:
        return safe("stop_vm", lambda: _run(node, vmid, "stop"))

    @mcp.tool(
        name="reboot_vm",
        title="Reboot VM (Graceful)",
        description=(
            "Send a graceful reboot signal to a running QEMU virtual machine "
            "via ACPI. The guest OS handles the restart."
        ),
        annotations=_SAFE_WRITE,
    )
    def reboot_vm(node: _Node, vmid: _VmId) -> str:
        return safe("reboot_vm", lambda: _run(node, vmid, "reboot"))

    @mcp.tool(
        name="reset_vm",
        title="Reset VM (Hard Reset)",
        description=(
            "Hard-reset a QEMU virtual machine, equivalent to pressing the "
            "physical reset button. Data loss may occur. "
            "Prefer reboot_vm for a graceful restart."
        ),
        annotations=_DESTRUCTIVE,
    )
    def reset_vm(node: _Node, vmid: _VmId) -> str:
        return safe("reset_vm", lambda: _run(node, vmid, "reset"))
