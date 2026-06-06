"""
Write tools for LXC container deletion — two-step confirmation required.

Same pattern as vm_delete.py. Separate token store for containers.

Step 1: container_delete_request  → returns token + container hostname
Step 2: container_delete_confirm  → requires token + exact hostname
"""
from __future__ import annotations

import logging
import secrets
import time
from typing import Any

from mcp.types import TextContent, Tool

from clustr.proxmox.client import ProxmoxError, get_client

logger = logging.getLogger(__name__)

_TOKEN_TTL = 300
_pending_deletes: dict[str, dict[str, Any]] = {}


def _purge_expired() -> None:
    now = time.monotonic()
    expired = [t for t, v in _pending_deletes.items() if v["expires"] < now]
    for t in expired:
        del _pending_deletes[t]


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

TOOL_CONTAINER_DELETE_REQUEST = Tool(
    name="container_delete_request",
    title="Request Container Deletion (Step 1 of 2)",
    description=(
        "Step 1 of 2: Request deletion of an LXC container. "
        "Returns a confirmation token and the container hostname. "
        "You MUST call container_delete_confirm with the token and exact "
        "hostname to complete the deletion. Token expires in 5 minutes. "
        "The container must be stopped before deletion."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Node name where the container resides"},
            "ctid": {"type": "integer", "description": "Container ID to delete", "minimum": 100},
        },
        "required": ["node", "ctid"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": True,
    },
)

TOOL_CONTAINER_DELETE_CONFIRM = Tool(
    name="container_delete_confirm",
    title="Confirm Container Deletion (Step 2 of 2)",
    description=(
        "Step 2 of 2: Permanently delete an LXC container. "
        "Requires the confirmation_token from container_delete_request AND "
        "the exact container hostname. "
        "WARNING: This permanently destroys the container and all its local storage. "
        "This action cannot be undone."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "confirmation_token": {
                "type": "string",
                "description": "Token returned by container_delete_request",
            },
            "container_hostname": {
                "type": "string",
                "description": "Exact hostname of the container as returned by container_delete_request",
            },
        },
        "required": ["confirmation_token", "container_hostname"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": True,
    },
)


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def _request_container_delete(node: str, ctid: int) -> dict[str, Any]:
    _purge_expired()
    client = get_client()

    try:
        config = client.nodes(node).lxc(ctid).config.get()
        hostname = config.get("hostname", f"ct-{ctid}")
    except Exception as exc:
        raise ProxmoxError(
            f"Container {ctid} not found on node '{node}': {exc}"
        ) from exc

    status = client.nodes(node).lxc(ctid).status.current.get()
    if status.get("status") == "running":
        raise ProxmoxError(
            f"Container {ctid} ({hostname}) is currently running. "
            f"Stop it before requesting deletion."
        )

    token = secrets.token_hex(16)
    _pending_deletes[token] = {
        "node": node,
        "ctid": ctid,
        "hostname": hostname,
        "expires": time.monotonic() + _TOKEN_TTL,
    }

    return {"token": token, "hostname": hostname, "ctid": ctid, "node": node}


def _confirm_container_delete(confirmation_token: str, container_hostname: str) -> str:
    _purge_expired()

    pending = _pending_deletes.get(confirmation_token)
    if pending is None:
        raise ProxmoxError(
            "Confirmation token not found or expired. "
            "Call container_delete_request again to get a fresh token."
        )

    if pending["hostname"] != container_hostname:
        raise ProxmoxError(
            f"Container hostname mismatch. "
            f"Expected '{pending['hostname']}', got '{container_hostname}'. "
            f"Provide the exact hostname returned by container_delete_request."
        )

    node = pending["node"]
    ctid = pending["ctid"]

    del _pending_deletes[confirmation_token]

    client = get_client()
    task_id = client.nodes(node).lxc(ctid).delete(purge=1, destroy_unreferenced_disks=1)
    return task_id


# ---------------------------------------------------------------------------
# Handler dispatcher
# ---------------------------------------------------------------------------

async def handle(tool_name: str, arguments: dict[str, Any]) -> list[TextContent]:
    try:
        if tool_name == "container_delete_request":
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

            result = _request_container_delete(node, ctid)
            return [
                TextContent(
                    type="text",
                    text=(
                        f"⚠️ **Container Deletion Request — Step 1 of 2**\n\n"
                        f"Container **{result['hostname']}** (ID: {result['ctid']}) on node "
                        f"**{result['node']}** is queued for deletion.\n\n"
                        f"To permanently delete it, call `container_delete_confirm` with:\n"
                        f"- `confirmation_token`: `{result['token']}`\n"
                        f"- `container_hostname`: `{result['hostname']}`\n\n"
                        f"⏰ Token expires in 5 minutes. This will permanently destroy the "
                        f"container and all its local storage."
                    ),
                )
            ]

        elif tool_name == "container_delete_confirm":
            confirmation_token = arguments.get("confirmation_token", "").strip()
            container_hostname = arguments.get("container_hostname", "").strip()

            if not confirmation_token:
                return [TextContent(type="text", text="Error: 'confirmation_token' is required.")]
            if not container_hostname:
                return [TextContent(type="text", text="Error: 'container_hostname' is required.")]

            task_id = _confirm_container_delete(confirmation_token, container_hostname)
            return [
                TextContent(
                    type="text",
                    text=(
                        f"💀 Container **{container_hostname}** deletion started.\n"
                        f"Task ID: `{task_id}`\n\n"
                        f"The container and all its local storage are being permanently destroyed."
                    ),
                )
            ]

        else:
            return [TextContent(type="text", text=f"Unknown tool: {tool_name}")]

    except ProxmoxError as exc:
        logger.error("Proxmox error in %s: %s", tool_name, exc)
        return [TextContent(type="text", text=f"Proxmox error: {exc}")]
