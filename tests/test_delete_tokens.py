"""
Tests for the two-step deletion token flow.

These tests exercise the token store logic in isolation — no Proxmox connection needed.
"""

import time
from unittest.mock import MagicMock, patch

import pytest


def _reset_vm_tokens():
    import clustr.tools.write.vm_delete as mod

    mod._pending_deletes.clear()


def _reset_ct_tokens():
    import clustr.tools.write.container_delete as mod

    mod._pending_deletes.clear()


def test_vm_delete_token_wrong_name_rejected():
    """Confirmation must fail if VM name doesn't match."""
    import clustr.tools.write.vm_delete as mod

    _reset_vm_tokens()

    import secrets
    import time

    token = secrets.token_hex(16)
    mod._pending_deletes[token] = {
        "node": "pve",
        "vmid": 100,
        "name": "my-vm",
        "expires": time.monotonic() + 300,
    }

    from clustr.proxmox.client import ProxmoxError

    with pytest.raises(ProxmoxError, match="mismatch"):
        mod._confirm_vm_delete(token, "wrong-name")

    _reset_vm_tokens()


def test_vm_delete_token_consumed_on_use():
    """Token must be removed from the store after successful confirm."""
    import clustr.tools.write.vm_delete as mod

    _reset_vm_tokens()

    import secrets
    import time

    token = secrets.token_hex(16)
    mod._pending_deletes[token] = {
        "node": "pve",
        "vmid": 100,
        "name": "my-vm",
        "expires": time.monotonic() + 300,
    }

    mock_client = MagicMock()
    mock_client.nodes.return_value.qemu.return_value.delete.return_value = "UPID:task"

    with patch("clustr.tools.write.vm_delete.get_client", return_value=mock_client):
        mod._confirm_vm_delete(token, "my-vm")

    assert token not in mod._pending_deletes
    _reset_vm_tokens()


def test_vm_delete_expired_token_rejected():
    """Expired tokens must be purged and rejected."""
    import clustr.tools.write.vm_delete as mod

    _reset_vm_tokens()

    import secrets

    token = secrets.token_hex(16)
    mod._pending_deletes[token] = {
        "node": "pve",
        "vmid": 100,
        "name": "my-vm",
        "expires": time.monotonic() - 1,  # already expired
    }

    from clustr.proxmox.client import ProxmoxError

    with pytest.raises(ProxmoxError, match="expired"):
        mod._confirm_vm_delete(token, "my-vm")

    _reset_vm_tokens()


def test_container_delete_token_wrong_hostname_rejected():
    """Confirm must fail if container hostname doesn't match."""
    import clustr.tools.write.container_delete as mod

    _reset_ct_tokens()

    import secrets

    token = secrets.token_hex(16)
    mod._pending_deletes[token] = {
        "node": "pve",
        "ctid": 103,
        "hostname": "my-container",
        "expires": time.monotonic() + 300,
    }

    from clustr.proxmox.client import ProxmoxError

    with pytest.raises(ProxmoxError, match="mismatch"):
        mod._confirm_container_delete(token, "wrong-hostname")

    _reset_ct_tokens()
