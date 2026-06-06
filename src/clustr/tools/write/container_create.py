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
from typing import Annotated, Any

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from clustr.proxmox.client import get_client, proxmox_post
from clustr.tools import safe

logger = logging.getLogger(__name__)


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

    task_id: str = proxmox_post(lambda: get_client().nodes(node).lxc.post(**params))

    if start_after_create:
        try:
            get_client().nodes(node).lxc(ctid).status.start.post()
        except Exception as exc:
            logger.warning("Container created but failed to start: %s", exc)

    return task_id


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------


def register(mcp: FastMCP) -> None:
    """Register the create_container tool onto the given FastMCP instance."""

    @mcp.tool(
        name="create_container",
        title="Create LXC Container",
        description=(
            "Create a new LXC container on a Proxmox node from a template. "
            "Requires a unique container ID, node name, hostname, OS template path, "
            "storage pool, and root disk size. "
            "The template must already exist on Proxmox storage — use the Proxmox "
            "UI or CLI to download templates first."
        ),
        annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False),
    )
    def create_container(
        node: Annotated[
            str,
            Field(description="Node to create the container on (e.g. 'pve')"),
        ],
        ctid: Annotated[
            int,
            Field(
                ge=100,
                le=999999,
                description="Unique container ID (100–999999). Must not already exist.",
            ),
        ],
        hostname: Annotated[
            str,
            Field(
                description="Container hostname (alphanumeric and hyphens, "
                "max 63 chars)"
            ),
        ],
        ostemplate: Annotated[
            str,
            Field(
                description="Template path on Proxmox storage, e.g. "
                "'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst'"
            ),
        ],
        storage: Annotated[
            str,
            Field(
                description="Storage pool for root disk (e.g. 'local-lvm'). "
                "Use list_storage to find available pools."
            ),
        ],
        disk_gb: Annotated[
            int, Field(ge=1, description="Root disk size in GB (default: 8)")
        ] = 8,
        cores: Annotated[
            int, Field(ge=1, le=128, description="Number of CPU cores (default: 1)")
        ] = 1,
        memory_mb: Annotated[
            int, Field(ge=128, description="Memory in MB (default: 512)")
        ] = 512,
        swap_mb: Annotated[
            int, Field(ge=0, description="Swap in MB (default: 512)")
        ] = 512,
        password: Annotated[
            str,
            Field(
                description="Root password for the container. "
                "If omitted, password login is disabled (SSH key recommended)."
            ),
        ] = "",
        ssh_public_key: Annotated[
            str,
            Field(
                description="SSH public key to inject into the container's "
                "authorized_keys."
            ),
        ] = "",
        unprivileged: Annotated[
            bool,
            Field(
                description="Create as unprivileged container "
                "(recommended, default: true)"
            ),
        ] = True,
        onboot: Annotated[
            bool,
            Field(
                description="Start container automatically on Proxmox boot "
                "(default: false)"
            ),
        ] = False,
        start_after_create: Annotated[
            bool,
            Field(
                description="Start the container immediately after creation "
                "(default: false)"
            ),
        ] = False,
        nameserver: Annotated[
            str, Field(description="DNS nameserver IP (e.g. '1.1.1.1'). Optional.")
        ] = "",
    ) -> str:
        def _do() -> str:
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
                nameserver=nameserver.strip(),
            )
            return (
                f"✅ Container **{hostname}** (ID: {ctid}) creation started "
                f"on node **{node}**.\n"
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
            )

        return safe("create_container", _do)
