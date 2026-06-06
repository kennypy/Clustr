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
from typing import Any

from mcp.types import TextContent, Tool

from clustr.proxmox.client import ProxmoxError, get_client

logger = logging.getLogger(__name__)

_SNAP_NAME_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,40}$")


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

TOOL_CREATE_CONTAINER_SNAPSHOT = Tool(
    name="create_container_snapshot",
    title="Create Container Snapshot",
    description=(
        "Create a snapshot of an LXC container. "
        "Snapshot names must be alphanumeric with hyphens/underscores, max 40 chars."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Node name"},
            "ctid": {"type": "integer", "description": "Container ID", "minimum": 100},
            "snapname": {
                "type": "string",
                "description": "Snapshot name (alphanumeric, hyphens, underscores; max 40 chars)",
            },
            "description": {
                "type": "string",
                "description": "Optional description",
                "default": "",
            },
        },
        "required": ["node", "ctid", "snapname"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": False,
    },
)

TOOL_DELETE_CONTAINER_SNAPSHOT = Tool(
    name="delete_container_snapshot",
    title="Delete Container Snapshot",
    description=(
        "Permanently delete a snapshot of an LXC container. "
        "This action cannot be undone."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Node name"},
            "ctid": {"type": "integer", "description": "Container ID", "minimum": 100},
            "snapname": {"type": "string", "description": "Exact snapshot name to delete"},
        },
        "required": ["node", "ctid", "snapname"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": True,
    },
)

TOOL_ROLLBACK_CONTAINER_SNAPSHOT = Tool(
    name="rollback_container_snapshot",
    title="Rollback Container to Snapshot",
    description=(
        "Rollback an LXC container to a previous snapshot state. "
        "WARNING: All changes after the snapshot was taken will be lost. "
        "The container must be stopped before rolling back."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Node name"},
            "ctid": {"type": "integer", "description": "Container ID", "minimum": 100},
            "snapname": {"type": "string", "description": "Snapshot name to roll back to"},
        },
        "required": ["node", "ctid", "snapname"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": True,
    },
)


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def _create_container_snapshot(
    node: str, ctid: int, snapname: str, description: str = ""
) -> str:
    client = get_client()
    params: dict[str, Any] = {"snapname": snapname}
    if description:
        params["description"] = description
    return client.nodes(node).lxc(ctid).snapshot.post(**params)


def _delete_container_snapshot(node: str, ctid: int, snapname: str) -> str:
    client = get_client()
    return client.nodes(node).lxc(ctid).snapshot(snapname).delete()


def _rollback_container_snapshot(node: str, ctid: int, snapname: str) -> str:
    client = get_client()
    return client.nodes(node).lxc(ctid).snapshot(snapname).rollback.post()


# ---------------------------------------------------------------------------
# Handler dispatcher
# ---------------------------------------------------------------------------

async def handle(tool_name: str, arguments: dict[str, Any]) -> list[TextContent]:
    node = arguments.get("node", "").strip()
    ctid_raw = arguments.get("ctid")
    snapname = arguments.get("snapname", "").strip()

    if not node:
        return [TextContent(type="text", text="Error: 'node' parameter is required.")]
    if ctid_raw is None:
        return [TextContent(type="text", text="Error: 'ctid' parameter is required.")]
    try:
        ctid = int(ctid_raw)
    except (TypeError, ValueError):
        return [TextContent(type="text", text="Error: 'ctid' must be an integer.")]
    if ctid < 100:
        return [TextContent(type="text", text="Error: 'ctid' must be >= 100.")]
    if not snapname:
        return [TextContent(type="text", text="Error: 'snapname' parameter is required.")]

    try:
        if tool_name == "create_container_snapshot":
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
            task_id = _create_container_snapshot(node, ctid, snapname, description)
            return [
                TextContent(
                    type="text",
                    text=(
                        f"✅ Snapshot **{snapname}** creation started for "
                        f"container {ctid} on {node}.\n"
                        f"Task ID: `{task_id}`\n\n"
                        f"Use `list_container_snapshots` to confirm when complete."
                    ),
                )
            ]

        elif tool_name == "delete_container_snapshot":
            task_id = _delete_container_snapshot(node, ctid, snapname)
            return [
                TextContent(
                    type="text",
                    text=(
                        f"✅ Snapshot **{snapname}** deletion started for "
                        f"container {ctid} on {node}.\n"
                        f"Task ID: `{task_id}`"
                    ),
                )
            ]

        elif tool_name == "rollback_container_snapshot":
            task_id = _rollback_container_snapshot(node, ctid, snapname)
            return [
                TextContent(
                    type="text",
                    text=(
                        f"✅ Rollback to snapshot **{snapname}** started for "
                        f"container {ctid} on {node}.\n"
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
