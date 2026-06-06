"""
Write tools for QEMU VM deletion — two-step confirmation required.

Step 1: vm_delete_request
    Returns a short-lived confirmation token and echoes back the VM name.

Step 2: vm_delete_confirm
    Requires the confirmation token AND the exact VM name.
    Only then is the Proxmox delete API called.

This prevents accidental deletion from a single misfire, even when Claude
is operating autonomously. Both tools are destructiveHint = True because
the intent of both calls in the flow is destruction.

Tokens are stored in-process memory (dict). They expire after 5 minutes.
On server restart all pending tokens are cleared — user must re-request.
"""
from __future__ import annotations

import logging
import secrets
import time
from typing import Any

from mcp.types import TextContent, Tool

from clustr.proxmox.client import ProxmoxError, get_client

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory token store
# { token: { "node": str, "vmid": int, "name": str, "expires": float } }
# ---------------------------------------------------------------------------
_TOKEN_TTL = 300  # 5 minutes
_pending_deletes: dict[str, dict[str, Any]] = {}


def _purge_expired() -> None:
    """Remove expired tokens — called on every request to avoid leaks."""
    now = time.monotonic()
    expired = [t for t, v in _pending_deletes.items() if v["expires"] < now]
    for t in expired:
        del _pending_deletes[t]


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

TOOL_VM_DELETE_REQUEST = Tool(
    name="vm_delete_request",
    title="Request VM Deletion (Step 1 of 2)",
    description=(
        "Step 1 of 2: Request deletion of a QEMU virtual machine. "
        "Returns a confirmation token and the VM name. "
        "You MUST call vm_delete_confirm with the token and exact VM name "
        "to complete the deletion. Token expires in 5 minutes. "
        "The VM must be stopped before deletion."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Node name where the VM resides"},
            "vmid": {"type": "integer", "description": "VM ID to delete", "minimum": 100},
        },
        "required": ["node", "vmid"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": True,
    },
)

TOOL_VM_DELETE_CONFIRM = Tool(
    name="vm_delete_confirm",
    title="Confirm VM Deletion (Step 2 of 2)",
    description=(
        "Step 2 of 2: Permanently delete a QEMU virtual machine. "
        "Requires the confirmation_token from vm_delete_request AND "
        "the exact VM name to confirm intent. "
        "WARNING: This permanently destroys the VM and all its local disks. "
        "This action cannot be undone."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "confirmation_token": {
                "type": "string",
                "description": "Token returned by vm_delete_request",
            },
            "vm_name": {
                "type": "string",
                "description": "Exact name of the VM as returned by vm_delete_request",
            },
        },
        "required": ["confirmation_token", "vm_name"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": True,
    },
)


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def _request_vm_delete(node: str, vmid: int) -> dict[str, Any]:
    """Look up the VM, register a delete token, return token + VM name."""
    _purge_expired()
    client = get_client()

    # Verify VM exists and get its name before issuing token
    try:
        config = client.nodes(node).qemu(vmid).config.get()
        vm_name = config.get("name", f"vm-{vmid}")
    except Exception as exc:
        raise ProxmoxError(f"VM {vmid} not found on node '{node}': {exc}") from exc

    # Check VM is not running
    status = client.nodes(node).qemu(vmid).status.current.get()
    if status.get("status") == "running":
        raise ProxmoxError(
            f"VM {vmid} ({vm_name}) is currently running. "
            f"Stop it before requesting deletion."
        )

    token = secrets.token_hex(16)
    _pending_deletes[token] = {
        "node": node,
        "vmid": vmid,
        "name": vm_name,
        "expires": time.monotonic() + _TOKEN_TTL,
    }

    return {"token": token, "vm_name": vm_name, "vmid": vmid, "node": node}


def _confirm_vm_delete(confirmation_token: str, vm_name: str) -> str:
    """Validate token + name match, then execute deletion."""
    _purge_expired()

    pending = _pending_deletes.get(confirmation_token)
    if pending is None:
        raise ProxmoxError(
            "Confirmation token not found or expired. "
            "Call vm_delete_request again to get a fresh token."
        )

    if pending["name"] != vm_name:
        raise ProxmoxError(
            f"VM name mismatch. Expected '{pending['name']}', got '{vm_name}'. "
            f"Provide the exact VM name returned by vm_delete_request."
        )

    node = pending["node"]
    vmid = pending["vmid"]

    # Consume the token — can only be used once
    del _pending_deletes[confirmation_token]

    client = get_client()
    task_id = client.nodes(node).qemu(vmid).delete(purge=1, destroy_unreferenced_disks=1)
    return task_id


# ---------------------------------------------------------------------------
# Handler dispatcher
# ---------------------------------------------------------------------------

async def handle(tool_name: str, arguments: dict[str, Any]) -> list[TextContent]:
    try:
        if tool_name == "vm_delete_request":
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

            result = _request_vm_delete(node, vmid)
            return [
                TextContent(
                    type="text",
                    text=(
                        f"⚠️ **VM Deletion Request — Step 1 of 2**\n\n"
                        f"VM **{result['vm_name']}** (ID: {result['vmid']}) on node **{result['node']}** "
                        f"is queued for deletion.\n\n"
                        f"To permanently delete it, call `vm_delete_confirm` with:\n"
                        f"- `confirmation_token`: `{result['token']}`\n"
                        f"- `vm_name`: `{result['vm_name']}`\n\n"
                        f"⏰ Token expires in 5 minutes. This will permanently destroy the VM "
                        f"and all its local disks."
                    ),
                )
            ]

        elif tool_name == "vm_delete_confirm":
            confirmation_token = arguments.get("confirmation_token", "").strip()
            vm_name = arguments.get("vm_name", "").strip()

            if not confirmation_token:
                return [TextContent(type="text", text="Error: 'confirmation_token' is required.")]
            if not vm_name:
                return [TextContent(type="text", text="Error: 'vm_name' is required.")]

            task_id = _confirm_vm_delete(confirmation_token, vm_name)
            return [
                TextContent(
                    type="text",
                    text=(
                        f"💀 VM **{vm_name}** deletion started.\n"
                        f"Task ID: `{task_id}`\n\n"
                        f"The VM and all its local disks are being permanently destroyed."
                    ),
                )
            ]

        else:
            return [TextContent(type="text", text=f"Unknown tool: {tool_name}")]

    except ProxmoxError as exc:
        logger.error("Proxmox error in %s: %s", tool_name, exc)
        return [TextContent(type="text", text=f"Proxmox error: {exc}")]
