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
from typing import Annotated, Any, cast

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from clustr.proxmox.client import ProxmoxError, get_client, proxmox_get, proxmox_post
from clustr.tools import safe

logger = logging.getLogger(__name__)

_TOKEN_TTL = 300
_pending_deletes: dict[str, dict[str, Any]] = {}

_DESTRUCTIVE = ToolAnnotations(readOnlyHint=False, destructiveHint=True)


def _purge_expired() -> None:
    now = time.monotonic()
    expired = [t for t, v in _pending_deletes.items() if v["expires"] < now]
    for t in expired:
        del _pending_deletes[t]


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------


def _request_container_delete(node: str, ctid: int) -> dict[str, Any]:
    _purge_expired()

    try:
        config = proxmox_get(lambda: get_client().nodes(node).lxc(ctid).config.get())
        hostname = config.get("hostname", f"ct-{ctid}")
    except Exception as exc:
        raise ProxmoxError(
            f"Container {ctid} not found on node '{node}': {exc}"
        ) from exc

    status = proxmox_get(
        lambda: get_client().nodes(node).lxc(ctid).status.current.get()
    )
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

    return cast(
        str,
        proxmox_post(
            lambda: get_client()
            .nodes(node)
            .lxc(ctid)
            .delete(purge=1, destroy_unreferenced_disks=1)
        ),
    )


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------


def register(mcp: FastMCP) -> None:
    """Register the two-step container deletion tools onto the FastMCP instance."""

    @mcp.tool(
        name="container_delete_request",
        title="Request Container Deletion (Step 1 of 2)",
        description=(
            "Step 1 of 2: Request deletion of an LXC container. "
            "Returns a confirmation token and the container hostname. "
            "You MUST call container_delete_confirm with the token and exact "
            "hostname to complete the deletion. Token expires in 5 minutes. "
            "The container must be stopped before deletion."
        ),
        annotations=_DESTRUCTIVE,
    )
    def container_delete_request(
        node: Annotated[
            str, Field(description="Node name where the container resides")
        ],
        ctid: Annotated[int, Field(ge=100, description="Container ID to delete")],
    ) -> str:
        def _do() -> str:
            result = _request_container_delete(node, ctid)
            return (
                f"⚠️ **Container Deletion Request — Step 1 of 2**\n\n"
                f"Container **{result['hostname']}** (ID: {result['ctid']}) on node "
                f"**{result['node']}** is queued for deletion.\n\n"
                f"To permanently delete it, call `container_delete_confirm` with:\n"
                f"- `confirmation_token`: `{result['token']}`\n"
                f"- `container_hostname`: `{result['hostname']}`\n\n"
                f"⏰ Token expires in 5 minutes. This will permanently destroy the "
                f"container and all its local storage."
            )

        return safe("container_delete_request", _do)

    @mcp.tool(
        name="container_delete_confirm",
        title="Confirm Container Deletion (Step 2 of 2)",
        description=(
            "Step 2 of 2: Permanently delete an LXC container. "
            "Requires the confirmation_token from container_delete_request AND "
            "the exact container hostname. "
            "WARNING: This permanently destroys the container and all its "
            "local storage. "
            "This action cannot be undone."
        ),
        annotations=_DESTRUCTIVE,
    )
    def container_delete_confirm(
        confirmation_token: Annotated[
            str, Field(description="Token returned by container_delete_request")
        ],
        container_hostname: Annotated[
            str,
            Field(
                description="Exact hostname of the container as returned by "
                "container_delete_request"
            ),
        ],
    ) -> str:
        def _do() -> str:
            task_id = _confirm_container_delete(confirmation_token, container_hostname)
            return (
                f"💀 Container **{container_hostname}** deletion started.\n"
                f"Task ID: `{task_id}`\n\n"
                f"The container and all its local storage are being "
                f"permanently destroyed."
            )

        return safe("container_delete_confirm", _do)
