"""
End-to-end tool execution tests with a mocked Proxmox client.

These exercise the full async path: FastMCP dispatch -> safe() offloads the
blocking body to a worker thread -> impl + formatter -> text result. They also
confirm errors come back as actionable text rather than raising.
"""

import os
from unittest.mock import MagicMock, patch

os.environ.setdefault("PROXMOX_HOST", "127.0.0.1")
os.environ.setdefault("PROXMOX_USER", "root@pam")
os.environ.setdefault("PROXMOX_TOKEN_NAME", "test")
os.environ.setdefault("PROXMOX_TOKEN_VALUE", "test")


def _text(result) -> str:
    """Flatten a FastMCP call_tool result into plain text."""
    # call_tool returns (content_blocks, structured) or a sequence of blocks.
    blocks = result[0] if isinstance(result, tuple) else result
    return "\n".join(getattr(b, "text", "") for b in blocks)


async def test_list_nodes_executes_and_formats():
    from clustr.server import mcp

    fake = MagicMock()
    fake.nodes.get.return_value = [
        {
            "node": "pve",
            "status": "online",
            "cpu": 0.25,
            "mem": 8 * 1024**3,
            "maxmem": 32 * 1024**3,
            "uptime": 7200,
            "type": "node",
        }
    ]
    with patch("clustr.tools.read.nodes.get_client", return_value=fake):
        out = _text(await mcp.call_tool("list_nodes", {}))

    assert "Cluster Nodes" in out
    assert "pve" in out
    assert "25.0%" in out


async def test_list_storage_by_node_reports_capacity():
    """
    Regression: node-filtered list_storage must read the node endpoint's
    total/used/avail fields, not the cluster endpoint's maxdisk/disk, or every
    pool renders as 0 GB.
    """
    from clustr.server import mcp

    fake = MagicMock()
    fake.nodes.return_value.storage.get.return_value = [
        {
            "storage": "local-lvm",
            "type": "lvmthin",
            "total": 100 * 1024**3,
            "used": 40 * 1024**3,
            "avail": 60 * 1024**3,
        }
    ]
    with patch("clustr.tools.read.storage.get_client", return_value=fake):
        out = _text(await mcp.call_tool("list_storage", {"node": "pve"}))

    assert "local-lvm" in out
    assert "100.0" in out  # total GB — would be 0.0 with the old field names
    assert "60.0" in out  # available GB
    assert "40.0%" in out  # used percentage


async def test_tool_error_returns_actionable_text():
    """A Proxmox failure must surface as text, not raise."""
    from clustr.proxmox.client import ProxmoxError
    from clustr.server import mcp

    fake = MagicMock()
    fake.nodes.get.side_effect = ProxmoxError("permission denied (403)")
    with patch("clustr.tools.read.nodes.get_client", return_value=fake):
        out = _text(await mcp.call_tool("list_nodes", {}))

    assert "Proxmox error" in out
    assert "permission denied" in out


_CREATE_ARGS = {
    "node": "pve",
    "vmid": 200,
    "name": "test-vm",
    "cores": 1,
    "memory_mb": 512,
    "disk_gb": 8,
    "storage": "local-lvm",
}


async def test_create_vm_dry_run_does_not_touch_proxmox():
    """Without confirm=true, create_vm previews the config and creates nothing."""
    from clustr.server import mcp

    with patch("clustr.tools.write.vm_create.get_client") as gc:
        out = _text(await mcp.call_tool("create_vm", dict(_CREATE_ARGS)))

    assert "not yet created" in out
    assert "confirm=true" in out
    gc.assert_not_called()  # no Proxmox call happened on a dry run


async def test_create_vm_confirm_true_creates():
    """With confirm=true, create_vm actually calls Proxmox and reports the task."""
    from clustr.server import mcp

    fake = MagicMock()
    fake.nodes.return_value.qemu.post.return_value = "UPID:create-vm"
    args = dict(_CREATE_ARGS, confirm=True, bridge="vmbr1")
    with patch("clustr.tools.write.vm_create.get_client", return_value=fake):
        out = _text(await mcp.call_tool("create_vm", args))

    assert "creation started" in out
    assert "UPID:create-vm" in out
    assert "vmbr1" in out  # custom bridge flowed through


async def test_create_vm_surfaces_failed_start():
    """
    Regression: start_after_create that fails must be reported to the caller,
    not swallowed behind a "creation started" success message.
    """
    from clustr.proxmox.client import ProxmoxError
    from clustr.server import mcp

    fake = MagicMock()
    fake.nodes.return_value.qemu.post.return_value = "UPID:create-vm"
    fake.nodes.return_value.qemu.return_value.status.start.post.side_effect = (
        ProxmoxError("disk still allocating")
    )
    args = dict(_CREATE_ARGS, confirm=True, start_after_create=True)
    with patch("clustr.tools.write.vm_create.get_client", return_value=fake):
        out = _text(await mcp.call_tool("create_vm", args))

    assert "creation started" in out  # the VM was created
    assert "start request failed" in out  # but the failed start is surfaced
    assert "disk still allocating" in out
    assert "start_vm" in out  # actionable next step


async def test_destructive_tool_requires_confirm():
    """stop_vm without confirm=true must not touch Proxmox."""
    from clustr.server import mcp

    with patch("clustr.tools.write.vm_power.get_client") as gc:
        out = _text(await mcp.call_tool("stop_vm", {"node": "pve", "vmid": 100}))

    assert "not executed" in out
    assert "confirm=true" in out
    gc.assert_not_called()


async def test_destructive_tool_confirm_true_executes():
    """stop_vm with confirm=true issues the force-stop."""
    from clustr.server import mcp

    fake = MagicMock()
    fake.nodes.return_value.qemu.return_value.status.stop.post.return_value = (
        "UPID:stop"
    )
    args = {"node": "pve", "vmid": 100, "confirm": True}
    with patch("clustr.tools.write.vm_power.get_client", return_value=fake):
        out = _text(await mcp.call_tool("stop_vm", args))

    assert "stop" in out
    assert "UPID:stop" in out
