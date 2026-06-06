"""
Write tools for LXC container snapshot management.

Annotations:
  - create_container_snapshot:   destructiveHint = False
  - delete_container_snapshot:   destructiveHint = True
  - rollback_container_snapshot: destructiveHint = True
"""

from __future__ import annotations

import logging
import re
from typing import Annotated, Any, cast

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from clustr.proxmox.client import get_client, proxmox_post
from clustr.tools import safe

logger = logging.getLogger(__name__)

_SNAP_NAME_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,40}$")

_SAFE_WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False)
_DESTRUCTIVE = ToolAnnotations(readOnlyHint=False, destructiveHint=True)

_Node = Annotated[str, Field(description="Node name")]
_CtId = Annotated[int, Field(ge=100, description="Container ID")]


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------


def _create_container_snapshot(
    node: str, ctid: int, snapname: str, description: str = ""
) -> str:
    params: dict[str, Any] = {"snapname": snapname}
    if description:
        params["description"] = description
    return cast(
        str,
        proxmox_post(
            lambda: get_client().nodes(node).lxc(ctid).snapshot.post(**params)
        ),
    )


def _delete_container_snapshot(node: str, ctid: int, snapname: str) -> str:
    return cast(
        str,
        proxmox_post(
            lambda: get_client().nodes(node).lxc(ctid).snapshot(snapname).delete()
        ),
    )


def _rollback_container_snapshot(node: str, ctid: int, snapname: str) -> str:
    return cast(
        str,
        proxmox_post(
            lambda: get_client()
            .nodes(node)
            .lxc(ctid)
            .snapshot(snapname)
            .rollback.post()
        ),
    )


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------


def register(mcp: FastMCP) -> None:
    """Register all container snapshot tools onto the given FastMCP instance."""

    @mcp.tool(
        name="create_container_snapshot",
        title="Create Container Snapshot",
        description=(
            "Create a snapshot of an LXC container. "
            "Snapshot names must be alphanumeric with hyphens/underscores, "
            "max 40 chars."
        ),
        annotations=_SAFE_WRITE,
    )
    async def create_container_snapshot(
        node: _Node,
        ctid: _CtId,
        snapname: Annotated[
            str,
            Field(
                description=(
                    "Snapshot name (alphanumeric, hyphens, underscores; "
                    "max 40 chars)"
                )
            ),
        ],
        description: Annotated[str, Field(description="Optional description")] = "",
    ) -> str:
        def _do() -> str:
            if not _SNAP_NAME_RE.match(snapname):
                return (
                    "Error: Snapshot name must be alphanumeric with "
                    "hyphens/underscores only, max 40 characters."
                )
            task_id = _create_container_snapshot(node, ctid, snapname, description)
            return (
                f"✅ Snapshot **{snapname}** creation started for "
                f"container {ctid} on {node}.\n"
                f"Task ID: `{task_id}`\n\n"
                f"Use `list_container_snapshots` to confirm when complete."
            )

        return await safe("create_container_snapshot", _do)

    @mcp.tool(
        name="delete_container_snapshot",
        title="Delete Container Snapshot",
        description=(
            "Permanently delete a snapshot of an LXC container. "
            "This action cannot be undone."
        ),
        annotations=_DESTRUCTIVE,
    )
    async def delete_container_snapshot(
        node: _Node,
        ctid: _CtId,
        snapname: Annotated[str, Field(description="Exact snapshot name to delete")],
    ) -> str:
        def _do() -> str:
            task_id = _delete_container_snapshot(node, ctid, snapname)
            return (
                f"✅ Snapshot **{snapname}** deletion started for "
                f"container {ctid} on {node}.\n"
                f"Task ID: `{task_id}`"
            )

        return await safe("delete_container_snapshot", _do)

    @mcp.tool(
        name="rollback_container_snapshot",
        title="Rollback Container to Snapshot",
        description=(
            "Rollback an LXC container to a previous snapshot state. "
            "WARNING: All changes after the snapshot was taken will be lost. "
            "The container must be stopped before rolling back."
        ),
        annotations=_DESTRUCTIVE,
    )
    async def rollback_container_snapshot(
        node: _Node,
        ctid: _CtId,
        snapname: Annotated[str, Field(description="Snapshot name to roll back to")],
    ) -> str:
        def _do() -> str:
            task_id = _rollback_container_snapshot(node, ctid, snapname)
            return (
                f"✅ Rollback to snapshot **{snapname}** started for "
                f"container {ctid} on {node}.\n"
                f"Task ID: `{task_id}`\n\n"
                f"⚠️ All changes after this snapshot was taken have been discarded."
            )

        return await safe("rollback_container_snapshot", _do)
