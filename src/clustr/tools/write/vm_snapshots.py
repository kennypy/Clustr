"""
Write tools for QEMU VM snapshot management.

Annotations:
  - create_vm_snapshot:   destructiveHint = False
  - delete_vm_snapshot:   destructiveHint = True
  - rollback_vm_snapshot: destructiveHint = True  (replaces current state)
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

# Snapshot name validation: alphanumeric + hyphens/underscores, max 40 chars
_SNAP_NAME_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,40}$")

_SAFE_WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False)
_DESTRUCTIVE = ToolAnnotations(readOnlyHint=False, destructiveHint=True)

_Node = Annotated[str, Field(description="Node name")]
_VmId = Annotated[int, Field(ge=100, description="VM ID")]


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
    params: dict[str, Any] = {"snapname": snapname}
    if description:
        params["description"] = description
    if include_ram:
        params["vmstate"] = 1
    return cast(
        str,
        proxmox_post(
            lambda: get_client().nodes(node).qemu(vmid).snapshot.post(**params)
        ),
    )


def _delete_vm_snapshot(node: str, vmid: int, snapname: str) -> str:
    return cast(
        str,
        proxmox_post(
            lambda: get_client().nodes(node).qemu(vmid).snapshot(snapname).delete()
        ),
    )


def _rollback_vm_snapshot(node: str, vmid: int, snapname: str) -> str:
    return cast(
        str,
        proxmox_post(
            lambda: get_client()
            .nodes(node)
            .qemu(vmid)
            .snapshot(snapname)
            .rollback.post()
        ),
    )


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------


def register(mcp: FastMCP) -> None:
    """Register all VM snapshot tools onto the given FastMCP instance."""

    @mcp.tool(
        name="create_vm_snapshot",
        title="Create VM Snapshot",
        description=(
            "Create a snapshot of a QEMU virtual machine. "
            "Snapshot names must be alphanumeric with hyphens/underscores, "
            "max 40 chars. "
            "Optionally include RAM state (VM must be running)."
        ),
        annotations=_SAFE_WRITE,
    )
    def create_vm_snapshot(
        node: _Node,
        vmid: _VmId,
        snapname: Annotated[
            str,
            Field(
                description=(
                    "Snapshot name (alphanumeric, hyphens, underscores; "
                    "max 40 chars)"
                )
            ),
        ],
        description: Annotated[
            str, Field(description="Optional description for the snapshot")
        ] = "",
        include_ram: Annotated[
            bool,
            Field(
                description=(
                    "Include RAM state in snapshot (VM must be running). "
                    "Default false."
                )
            ),
        ] = False,
    ) -> str:
        def _do() -> str:
            if not _SNAP_NAME_RE.match(snapname):
                return (
                    "Error: Snapshot name must be alphanumeric with "
                    "hyphens/underscores only, max 40 characters."
                )
            task_id = _create_vm_snapshot(
                node, vmid, snapname, description, include_ram
            )
            return (
                f"✅ Snapshot **{snapname}** creation started for VM "
                f"{vmid} on {node}.\n"
                f"Task ID: `{task_id}`\n\n"
                f"Use `list_vm_snapshots` to confirm when complete."
            )

        return safe("create_vm_snapshot", _do)

    @mcp.tool(
        name="delete_vm_snapshot",
        title="Delete VM Snapshot",
        description=(
            "Permanently delete a snapshot of a QEMU virtual machine. "
            "This action cannot be undone."
        ),
        annotations=_DESTRUCTIVE,
    )
    def delete_vm_snapshot(
        node: _Node,
        vmid: _VmId,
        snapname: Annotated[str, Field(description="Exact snapshot name to delete")],
    ) -> str:
        def _do() -> str:
            task_id = _delete_vm_snapshot(node, vmid, snapname)
            return (
                f"✅ Snapshot **{snapname}** deletion started for VM "
                f"{vmid} on {node}.\n"
                f"Task ID: `{task_id}`"
            )

        return safe("delete_vm_snapshot", _do)

    @mcp.tool(
        name="rollback_vm_snapshot",
        title="Rollback VM to Snapshot",
        description=(
            "Rollback a QEMU virtual machine to a previous snapshot state. "
            "WARNING: All changes made after the snapshot was taken will be lost. "
            "The VM must be stopped before rolling back."
        ),
        annotations=_DESTRUCTIVE,
    )
    def rollback_vm_snapshot(
        node: _Node,
        vmid: _VmId,
        snapname: Annotated[str, Field(description="Snapshot name to roll back to")],
    ) -> str:
        def _do() -> str:
            task_id = _rollback_vm_snapshot(node, vmid, snapname)
            return (
                f"✅ Rollback to snapshot **{snapname}** started for VM "
                f"{vmid} on {node}.\n"
                f"Task ID: `{task_id}`\n\n"
                f"⚠️ All changes after this snapshot was taken have been discarded."
            )

        return safe("rollback_vm_snapshot", _do)
