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
import threading
import time
from typing import Annotated, Any, cast

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from clustr.proxmox.client import ProxmoxError, get_client, proxmox_get, proxmox_post
from clustr.tools import safe

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory token store
# { token: { "node": str, "vmid": int, "name": str, "expires": float } }
# ---------------------------------------------------------------------------
_TOKEN_TTL = 300  # 5 minutes
_pending_deletes: dict[str, dict[str, Any]] = {}
# Tools run in worker threads (anyio.to_thread), so the token store can be
# touched concurrently. Guard every read/modify/write of _pending_deletes.
_lock = threading.Lock()

# Step 1 (request) destroys nothing — it only looks the VM up and mints a
# short-lived token — so it is not flagged destructive. Step 2 (confirm) is.
_REQUEST = ToolAnnotations(readOnlyHint=False, destructiveHint=False)
_DESTRUCTIVE = ToolAnnotations(readOnlyHint=False, destructiveHint=True)


def _purge_expired() -> None:
    """Remove expired tokens. Caller must hold ``_lock``."""
    now = time.monotonic()
    expired = [t for t, v in _pending_deletes.items() if v["expires"] < now]
    for t in expired:
        del _pending_deletes[t]


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------


def _request_vm_delete(node: str, vmid: int) -> dict[str, Any]:
    """Look up the VM, register a delete token, return token + VM name."""
    # Verify VM exists and get its name before issuing token
    try:
        config = proxmox_get(lambda: get_client().nodes(node).qemu(vmid).config.get())
        vm_name = config.get("name", f"vm-{vmid}")
    except Exception as exc:
        raise ProxmoxError(f"VM {vmid} not found on node '{node}': {exc}") from exc

    # Check VM is not running
    status = proxmox_get(
        lambda: get_client().nodes(node).qemu(vmid).status.current.get()
    )
    if status.get("status") == "running":
        raise ProxmoxError(
            f"VM {vmid} ({vm_name}) is currently running. "
            f"Stop it before requesting deletion."
        )

    token = secrets.token_hex(16)
    with _lock:
        _purge_expired()
        _pending_deletes[token] = {
            "node": node,
            "vmid": vmid,
            "name": vm_name,
            "expires": time.monotonic() + _TOKEN_TTL,
        }

    return {"token": token, "vm_name": vm_name, "vmid": vmid, "node": node}


def _confirm_vm_delete(confirmation_token: str, vm_name: str) -> str:
    """Validate token + name match, then execute deletion."""
    # Atomically validate and consume the token so two concurrent confirms can't
    # both pass before either deletes (the delete itself runs outside the lock).
    with _lock:
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

        # Consume the token — can only be used once
        del _pending_deletes[confirmation_token]

    node = pending["node"]
    vmid = pending["vmid"]

    return cast(
        str,
        proxmox_post(
            lambda: get_client()
            .nodes(node)
            .qemu(vmid)
            # Proxmox's API parameter is hyphenated; proxmoxer passes kwargs
            # through verbatim, and a Python identifier can't contain a hyphen,
            # so it must be supplied via dict-unpacking. An underscore variant is
            # rejected by Proxmox's schema validator (HTTP 400).
            .delete(purge=1, **{"destroy-unreferenced-disks": 1})
        ),
    )


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------


def register(mcp: FastMCP) -> None:
    """Register the two-step VM deletion tools onto the given FastMCP instance."""

    @mcp.tool(
        name="vm_delete_request",
        title="Request VM Deletion (Step 1 of 2)",
        description=(
            "Step 1 of 2: Request deletion of a QEMU virtual machine. "
            "Returns a confirmation token and the VM name. "
            "You MUST call vm_delete_confirm with the token and exact VM name "
            "to complete the deletion. Token expires in 5 minutes. "
            "The VM must be stopped before deletion."
        ),
        annotations=_REQUEST,
    )
    async def vm_delete_request(
        node: Annotated[str, Field(description="Node name where the VM resides")],
        vmid: Annotated[int, Field(ge=100, description="VM ID to delete")],
    ) -> str:
        def _do() -> str:
            result = _request_vm_delete(node, vmid)
            return (
                f"⚠️ **VM Deletion Request — Step 1 of 2**\n\n"
                f"VM **{result['vm_name']}** (ID: {result['vmid']}) on node "
                f"**{result['node']}** is queued for deletion.\n\n"
                f"To permanently delete it, call `vm_delete_confirm` with:\n"
                f"- `confirmation_token`: `{result['token']}`\n"
                f"- `vm_name`: `{result['vm_name']}`\n\n"
                f"⏰ Token expires in 5 minutes. This will permanently destroy the VM "
                f"and all its local disks."
            )

        return await safe("vm_delete_request", _do)

    @mcp.tool(
        name="vm_delete_confirm",
        title="Confirm VM Deletion (Step 2 of 2)",
        description=(
            "Step 2 of 2: Permanently delete a QEMU virtual machine. "
            "Requires the confirmation_token from vm_delete_request AND "
            "the exact VM name to confirm intent. "
            "WARNING: This permanently destroys the VM and all its local disks. "
            "This action cannot be undone."
        ),
        annotations=_DESTRUCTIVE,
    )
    async def vm_delete_confirm(
        confirmation_token: Annotated[
            str, Field(description="Token returned by vm_delete_request")
        ],
        vm_name: Annotated[
            str,
            Field(description="Exact name of the VM as returned by vm_delete_request"),
        ],
    ) -> str:
        def _do() -> str:
            task_id = _confirm_vm_delete(confirmation_token, vm_name)
            return (
                f"💀 VM **{vm_name}** deletion started.\n"
                f"Task ID: `{task_id}`\n\n"
                f"The VM and all its local disks are being permanently destroyed."
            )

        return await safe("vm_delete_confirm", _do)
