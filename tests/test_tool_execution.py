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
