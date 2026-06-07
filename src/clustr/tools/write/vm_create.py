"""
Write tool for creating QEMU virtual machines.

Provides sane defaults while exposing the most commonly needed parameters.
Does not attempt to wrap every Proxmox QEMU config option — the Proxmox
UI exists for complex configurations.

destructiveHint = False: creating a VM is additive, not destructive.
readOnlyHint = False: this is a mutating operation.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any, Literal

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from clustr.proxmox.client import ProxmoxError, get_client, proxmox_post
from clustr.tools import safe

logger = logging.getLogger(__name__)

# Valid OS types Proxmox accepts
_OsType = Literal[
    "l26",  # Linux 2.6+
    "l24",  # Linux 2.4
    "win11",  # Windows 11
    "win10",  # Windows 10/2016/2019
    "win8",  # Windows 8.x/2012
    "win7",  # Windows 7/2008
    "wxp",  # Windows XP/2003
    "solaris",
    "other",
]


# ---------------------------------------------------------------------------
# Tool implementation
# ---------------------------------------------------------------------------


def _create_vm(
    node: str,
    vmid: int,
    name: str,
    cores: int,
    memory_mb: int,
    disk_gb: int,
    storage: str,
    os_type: str = "l26",
    iso_path: str = "",
    bridge: str = "vmbr0",
    onboot: bool = False,
    start_after_create: bool = False,
) -> str:
    params: dict[str, Any] = {
        "vmid": vmid,
        "name": name,
        "cores": cores,
        "sockets": 1,
        "memory": memory_mb,
        "ostype": os_type,
        "onboot": 1 if onboot else 0,
        "agent": "enabled=1",
        # Primary disk — scsi0
        "scsi0": f"{storage}:{disk_gb}",
        "scsihw": "virtio-scsi-pci",
        # Boot order
        "boot": "order=scsi0",
        # Network
        "net0": f"virtio,bridge={bridge}",
        # Display
        "vga": "std",
        # Tablet for pointer alignment in VNC
        "tablet": 1,
    }

    if iso_path:
        params["ide2"] = f"{iso_path},media=cdrom"
        # If ISO provided, prefer booting from CD first for OS install
        params["boot"] = "order=ide2;scsi0"

    task_id: str = proxmox_post(lambda: get_client().nodes(node).qemu.post(**params))

    if start_after_create:
        try:
            proxmox_post(
                lambda: get_client().nodes(node).qemu(vmid).status.start.post()
            )
        except ProxmoxError as exc:
            logger.warning("VM created but failed to start: %s", exc)

    return task_id


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------


def register(mcp: FastMCP) -> None:
    """Register the create_vm tool onto the given FastMCP instance."""

    @mcp.tool(
        name="create_vm",
        title="Create Virtual Machine",
        description=(
            "Create a new QEMU virtual machine on a Proxmox node. "
            "Requires a unique VM ID, node name, VM name, number of cores, "
            "memory in MB, and disk size in GB. "
            "An ISO image path on Proxmox storage can be provided to attach "
            "as a CD-ROM for OS installation."
        ),
        annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False),
    )
    async def create_vm(
        node: Annotated[
            str, Field(description="Node to create the VM on (e.g. 'pve')")
        ],
        vmid: Annotated[
            int,
            Field(
                ge=100,
                le=999999,
                description="Unique VM ID (100–999999). Must not already exist.",
            ),
        ],
        name: Annotated[
            str,
            Field(description="VM name (alphanumeric, hyphens allowed, max 64 chars)"),
        ],
        cores: Annotated[
            int, Field(ge=1, le=128, description="Number of CPU cores (default: 2)")
        ] = 2,
        memory_mb: Annotated[
            int, Field(ge=256, description="Memory in MB (default: 2048)")
        ] = 2048,
        disk_gb: Annotated[
            int, Field(ge=1, description="Primary disk size in GB (default: 32)")
        ] = 32,
        storage: Annotated[
            str,
            Field(
                description="Storage pool for the disk (e.g. 'local-lvm', "
                "'vm-storage'). Use list_storage to find available pools."
            ),
        ] = "local-lvm",
        os_type: Annotated[
            _OsType,
            Field(
                description="OS type hint: l26 (Linux), win11, win10, win8, "
                "other. Default: l26"
            ),
        ] = "l26",
        iso_path: Annotated[
            str,
            Field(
                description="Optional: Path to ISO on Proxmox storage for OS "
                "install, e.g. 'local:iso/ubuntu-24.04.iso'. Leave empty for "
                "diskless."
            ),
        ] = "",
        onboot: Annotated[
            bool,
            Field(
                description="Start VM automatically on Proxmox boot " "(default: false)"
            ),
        ] = False,
        start_after_create: Annotated[
            bool,
            Field(
                description="Start the VM immediately after creation "
                "(default: false)"
            ),
        ] = False,
        bridge: Annotated[
            str,
            Field(description="Network bridge for the primary NIC (default: vmbr0)"),
        ] = "vmbr0",
        confirm: Annotated[
            bool,
            Field(
                description="Must be true to actually create the VM. When false "
                "(default), returns the exact config that WOULD be created so it "
                "can be reviewed — then call again with confirm=true."
            ),
        ] = False,
    ) -> str:
        def _do() -> str:
            config = (
                f"**Config:**\n"
                f"- Node: `{node}`\n"
                f"- VM ID: `{vmid}`  Name: `{name}`\n"
                f"- CPU: {cores} core(s)\n"
                f"- Memory: {memory_mb} MB\n"
                f"- Disk: {disk_gb} GB on `{storage}`\n"
                f"- OS type: `{os_type}`\n"
                f"- ISO: `{iso_path.strip() or 'none'}`\n"
                f"- Network: `virtio` on bridge `{bridge}`\n"
                f"- Start on boot: {'yes' if onboot else 'no'}\n"
                f"- Start after create: {'yes' if start_after_create else 'no'}\n"
            )
            if not confirm:
                return (
                    f"🔎 **Review — VM not yet created.**\n\n{config}\n"
                    f"Call `create_vm` again with the same arguments plus "
                    f"`confirm=true` to create it."
                )
            task_id = _create_vm(
                node=node,
                vmid=vmid,
                name=name,
                cores=cores,
                memory_mb=memory_mb,
                disk_gb=disk_gb,
                storage=storage,
                os_type=os_type,
                iso_path=iso_path.strip(),
                bridge=bridge,
                onboot=onboot,
                start_after_create=start_after_create,
            )
            return (
                f"✅ VM **{name}** (ID: {vmid}) creation started on node "
                f"**{node}**.\n"
                f"Task ID: `{task_id}`\n\n"
                f"{config}\n"
                f"Use `get_vm_status` to check when the VM is ready."
            )

        return await safe("create_vm", _do)
