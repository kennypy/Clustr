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
from typing import Any

from mcp.types import TextContent, Tool

from clustr.proxmox.client import ProxmoxError, get_client

logger = logging.getLogger(__name__)

# Valid OS types Proxmox accepts
_VALID_OS_TYPES = {
    "l26",    # Linux 2.6+
    "l24",    # Linux 2.4
    "win11",  # Windows 11
    "win10",  # Windows 10/2016/2019
    "win8",   # Windows 8.x/2012
    "win7",   # Windows 7/2008
    "wxp",    # Windows XP/2003
    "solaris",
    "other",
}


# ---------------------------------------------------------------------------
# Tool definition
# ---------------------------------------------------------------------------

TOOL_CREATE_VM = Tool(
    name="create_vm",
    title="Create Virtual Machine",
    description=(
        "Create a new QEMU virtual machine on a Proxmox node. "
        "Requires a unique VM ID, node name, VM name, number of cores, "
        "memory in MB, and disk size in GB. "
        "An ISO image path on Proxmox storage can be provided to attach "
        "as a CD-ROM for OS installation."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "node": {
                "type": "string",
                "description": "Node to create the VM on (e.g. 'pve')",
            },
            "vmid": {
                "type": "integer",
                "description": "Unique VM ID (100–999999). Must not already exist.",
                "minimum": 100,
                "maximum": 999999,
            },
            "name": {
                "type": "string",
                "description": "VM name (alphanumeric, hyphens allowed, max 64 chars)",
            },
            "cores": {
                "type": "integer",
                "description": "Number of CPU cores (default: 2)",
                "minimum": 1,
                "maximum": 128,
                "default": 2,
            },
            "memory_mb": {
                "type": "integer",
                "description": "Memory in MB (default: 2048)",
                "minimum": 256,
                "default": 2048,
            },
            "disk_gb": {
                "type": "integer",
                "description": "Primary disk size in GB (default: 32)",
                "minimum": 1,
                "default": 32,
            },
            "storage": {
                "type": "string",
                "description": "Storage pool for the disk (e.g. 'local-lvm', 'vm-storage'). "
                               "Use list_storage to find available pools.",
                "default": "local-lvm",
            },
            "os_type": {
                "type": "string",
                "description": "OS type hint: l26 (Linux), win11, win10, win8, other. "
                               "Default: l26",
                "default": "l26",
                "enum": sorted(_VALID_OS_TYPES),
            },
            "iso_path": {
                "type": "string",
                "description": "Optional: Path to ISO on Proxmox storage for OS install, "
                               "e.g. 'local:iso/ubuntu-24.04.iso'. Leave empty for diskless.",
            },
            "onboot": {
                "type": "boolean",
                "description": "Start VM automatically on Proxmox boot (default: false)",
                "default": False,
            },
            "start_after_create": {
                "type": "boolean",
                "description": "Start the VM immediately after creation (default: false)",
                "default": False,
            },
        },
        "required": ["node", "vmid", "name", "cores", "memory_mb", "disk_gb", "storage"],
    },
    annotations={
        "readOnlyHint": False,
        "destructiveHint": False,
    },
)


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
    onboot: bool = False,
    start_after_create: bool = False,
) -> str:
    client = get_client()

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
        "net0": "virtio,bridge=vmbr0",
        # Display
        "vga": "std",
        # Tablet for pointer alignment in VNC
        "tablet": 1,
    }

    if iso_path:
        params["ide2"] = f"{iso_path},media=cdrom"
        # If ISO provided, prefer booting from CD first for OS install
        params["boot"] = "order=ide2;scsi0"

    task_id = client.nodes(node).qemu.post(**params)

    if start_after_create:
        try:
            client.nodes(node).qemu(vmid).status.start.post()
        except Exception as exc:
            logger.warning("VM created but failed to start: %s", exc)

    return task_id


# ---------------------------------------------------------------------------
# Handler dispatcher
# ---------------------------------------------------------------------------

async def handle(tool_name: str, arguments: dict[str, Any]) -> list[TextContent]:
    if tool_name != "create_vm":
        return [TextContent(type="text", text=f"Unknown tool: {tool_name}")]

    # Required parameters
    node = arguments.get("node", "").strip()
    vmid_raw = arguments.get("vmid")
    name = arguments.get("name", "").strip()
    cores_raw = arguments.get("cores", 2)
    memory_raw = arguments.get("memory_mb", 2048)
    disk_raw = arguments.get("disk_gb", 32)
    storage = arguments.get("storage", "local-lvm").strip()

    # Validation
    if not node:
        return [TextContent(type="text", text="Error: 'node' is required.")]
    if not name:
        return [TextContent(type="text", text="Error: 'name' is required.")]
    if vmid_raw is None:
        return [TextContent(type="text", text="Error: 'vmid' is required.")]
    if not storage:
        return [TextContent(type="text", text="Error: 'storage' is required.")]

    try:
        vmid = int(vmid_raw)
        cores = int(cores_raw)
        memory_mb = int(memory_raw)
        disk_gb = int(disk_raw)
    except (TypeError, ValueError):
        return [TextContent(type="text", text="Error: vmid, cores, memory_mb, disk_gb must be integers.")]

    if vmid < 100:
        return [TextContent(type="text", text="Error: 'vmid' must be >= 100.")]
    if cores < 1:
        return [TextContent(type="text", text="Error: 'cores' must be >= 1.")]
    if memory_mb < 256:
        return [TextContent(type="text", text="Error: 'memory_mb' must be >= 256.")]
    if disk_gb < 1:
        return [TextContent(type="text", text="Error: 'disk_gb' must be >= 1.")]

    os_type = arguments.get("os_type", "l26").strip()
    if os_type not in _VALID_OS_TYPES:
        return [
            TextContent(
                type="text",
                text=f"Error: Invalid os_type '{os_type}'. "
                     f"Valid values: {', '.join(sorted(_VALID_OS_TYPES))}",
            )
        ]

    iso_path = arguments.get("iso_path", "").strip()
    onboot = bool(arguments.get("onboot", False))
    start_after_create = bool(arguments.get("start_after_create", False))

    try:
        task_id = _create_vm(
            node=node,
            vmid=vmid,
            name=name,
            cores=cores,
            memory_mb=memory_mb,
            disk_gb=disk_gb,
            storage=storage,
            os_type=os_type,
            iso_path=iso_path,
            onboot=onboot,
            start_after_create=start_after_create,
        )
        return [
            TextContent(
                type="text",
                text=(
                    f"✅ VM **{name}** (ID: {vmid}) creation started on node **{node}**.\n"
                    f"Task ID: `{task_id}`\n\n"
                    f"**Config:**\n"
                    f"- CPU: {cores} core(s)\n"
                    f"- Memory: {memory_mb} MB\n"
                    f"- Disk: {disk_gb} GB on `{storage}`\n"
                    f"- OS type: `{os_type}`\n"
                    f"- ISO: `{iso_path or 'none'}`\n"
                    f"- Start on boot: {'yes' if onboot else 'no'}\n\n"
                    f"Use `get_vm_status` to check when the VM is ready."
                ),
            )
        ]
    except ProxmoxError as exc:
        logger.error("Proxmox error in create_vm: %s", exc)
        return [TextContent(type="text", text=f"Proxmox error: {exc}")]
