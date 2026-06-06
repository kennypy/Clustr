"""
Write tool for creating LXC containers.

Covers the common case: pull a template from storage, configure resources,
attach to the default bridge. Complex configs (multiple mounts, multiple
network interfaces, nesting) are better handled via the Proxmox UI.

destructiveHint = False: creating a container is additive.
readOnlyHint = False: mutating operation.
"""
from __future__ import annotations

import logging
from typing import Any

from mcp.types import TextContent, Tool

from clustr.proxmox.client import ProxmoxError, get_client

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tool definition
# ---------------------------------------------------------------------------

TOOL_CREATE_CONTAINER = Tool(
    name="create_container",
    title="Create LXC Container",
    description=(
        "Create a new LXC container on a Proxmox node from a template. "
        "Requires a unique container ID, node name, hostname, OS template path, "
        "storage pool, and root disk size. "
        "The template must already exist on Proxmox storage — use the Proxmox "
        "UI or CLI to download templates first."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {
                "type": "string",
                "description": "Node to create the container on (e.g. 'pve')",
            },
            "ctid": {
                "type": "integer",
                "description": "Unique container ID (100–999999). Must not already exist.",
                "minimum": 100,
                "maximum": 999999,
            },
            "hostname": {
                "type": "string",
                "description": "Container hostname (alphanumeric and hyphens, max 63 chars)",
            },
            "ostemplate": {
                "type": "string",
                "description": (
                    "Template path on Proxmox storage, e.g. "
                    "'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst'"
                ),
            },
            "storage": {
                "type": "string",
                "description": "Storage pool for root disk (e.g. 'local-lvm'). "
                               "Use list_storage to find available pools.",
            },
            "disk_gb": {
                "type": "integer",
                "description": "Root disk size in GB (default: 8)",
                "minimum": 1,
                "default": 8,
            },
            "cores": {
                "type": "integer",
                "description": "Number of CPU cores (default: 1)",
                "minimum": 1,
                "maximum": 128,
                "default": 1,
            },
            "memory_mb": {
                "type": "integer",
                "description": "Memory in MB (default: 512)",
                "minimum": 128,
                "default": 512,
            },
            "swap_mb": {
                "type": "integer",
                "description": "Swap in MB (default: 512)",
                "minimum": 0,
                "default": 512,
            },
            "password": {
                "type": "string",
                "description": "Root password for the container. "
                               "If omitted, password login is disabled (SSH key recommended).",
            },
            "ssh_public_key": {
                "type": "string",
                "description": "SSH public key to inject into the container's authorized_keys.",
            },
            "unprivileged": {
                "type": "boolean",
                "description": "Create as unprivileged container (recommended, default: true)",
                "default": True,
            },
            "onboot": {
                "type": "boolean",
                "description": "Start container automatically on Proxmox boot (default: false)",
                "default": False,
            },
            "start_after_create": {
                "type": "boolean",
                "description": "Start the container immediately after creation (default: false)",
                "default": False,
            },
            "nameserver": {
                "type": "string",
                "description": "DNS nameserver IP (e.g. '1.1.1.1'). Optional.",
            },
        },
        "required": ["node", "ctid", "hostname", "ostemplate", "storage"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": False,
    },
)


# ---------------------------------------------------------------------------
# Tool implementation
# ---------------------------------------------------------------------------

def _create_container(
    node: str,
    ctid: int,
    hostname: str,
    ostemplate: str,
    storage: str,
    disk_gb: int = 8,
    cores: int = 1,
    memory_mb: int = 512,
    swap_mb: int = 512,
    password: str = "",
    ssh_public_key: str = "",
    unprivileged: bool = True,
    onboot: bool = False,
    start_after_create: bool = False,
    nameserver: str = "",
) -> str:
    client = get_client()

    params: dict[str, Any] = {
        "vmid": ctid,
        "hostname": hostname,
        "ostemplate": ostemplate,
        "storage": storage,
        "rootfs": f"{storage}:{disk_gb}",
        "cores": cores,
        "memory": memory_mb,
        "swap": swap_mb,
        "unprivileged": 1 if unprivileged else 0,
        "onboot": 1 if onboot else 0,
        "net0": "name=eth0,bridge=vmbr0,ip=dhcp",
    }

    if password:
        params["password"] = password

    if ssh_public_key:
        params["ssh-public-keys"] = ssh_public_key

    if nameserver:
        params["nameserver"] = nameserver

    task_id = client.nodes(node).lxc.post(**params)

    if start_after_create:
        try:
            client.nodes(node).lxc(ctid).status.start.post()
        except Exception as exc:
            logger.warning("Container created but failed to start: %s", exc)

    return task_id


# ---------------------------------------------------------------------------
# Handler dispatcher
# ---------------------------------------------------------------------------

async def handle(tool_name: str, arguments: dict[str, Any]) -> list[TextContent]:
    if tool_name != "create_container":
        return [TextContent(type="text", text=f"Unknown tool: {tool_name}")]

    node = arguments.get("node", "").strip()
    ctid_raw = arguments.get("ctid")
    hostname = arguments.get("hostname", "").strip()
    ostemplate = arguments.get("ostemplate", "").strip()
    storage = arguments.get("storage", "").strip()

    if not node:
        return [TextContent(type="text", text="Error: 'node' is required.")]
    if not hostname:
        return [TextContent(type="text", text="Error: 'hostname' is required.")]
    if not ostemplate:
        return [TextContent(type="text", text="Error: 'ostemplate' is required.")]
    if not storage:
        return [TextContent(type="text", text="Error: 'storage' is required.")]
    if ctid_raw is None:
        return [TextContent(type="text", text="Error: 'ctid' is required.")]

    try:
        ctid = int(ctid_raw)
        disk_gb = int(arguments.get("disk_gb", 8))
        cores = int(arguments.get("cores", 1))
        memory_mb = int(arguments.get("memory_mb", 512))
        swap_mb = int(arguments.get("swap_mb", 512))
    except (TypeError, ValueError):
        return [TextContent(type="text", text="Error: ctid, disk_gb, cores, memory_mb, swap_mb must be integers.")]

    if ctid < 100:
        return [TextContent(type="text", text="Error: 'ctid' must be >= 100.")]

    password = arguments.get("password", "")
    ssh_public_key = arguments.get("ssh_public_key", "")
    unprivileged = bool(arguments.get("unprivileged", True))
    onboot = bool(arguments.get("onboot", False))
    start_after_create = bool(arguments.get("start_after_create", False))
    nameserver = arguments.get("nameserver", "").strip()

    try:
        task_id = _create_container(
            node=node,
            ctid=ctid,
            hostname=hostname,
            ostemplate=ostemplate,
            storage=storage,
            disk_gb=disk_gb,
            cores=cores,
            memory_mb=memory_mb,
            swap_mb=swap_mb,
            password=password,
            ssh_public_key=ssh_public_key,
            unprivileged=unprivileged,
            onboot=onboot,
            start_after_create=start_after_create,
            nameserver=nameserver,
        )
        return [
            TextContent(
                type="text",
                text=(
                    f"✅ Container **{hostname}** (ID: {ctid}) creation started on node **{node}**.\n"
                    f"Task ID: `{task_id}`\n\n"
                    f"**Config:**\n"
                    f"- CPU: {cores} core(s)\n"
                    f"- Memory: {memory_mb} MB\n"
                    f"- Swap: {swap_mb} MB\n"
                    f"- Root disk: {disk_gb} GB on `{storage}`\n"
                    f"- Template: `{ostemplate}`\n"
                    f"- Unprivileged: {'yes' if unprivileged else 'no'}\n"
                    f"- Start on boot: {'yes' if onboot else 'no'}\n\n"
                    f"Use `get_container_status` to check when the container is ready."
                ),
            )
        ]
    except ProxmoxError as exc:
        logger.error("Proxmox error in create_container: %s", exc)
        return [TextContent(type="text", text=f"Proxmox error: {exc}")]
