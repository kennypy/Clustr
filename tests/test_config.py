"""Tests for configuration loading."""

import os
from unittest.mock import patch

import pytest


def test_safe_bind_allows_loopback():
    """Loopback bind with no auth is allowed (not reachable off-box)."""
    from clustr.server import _check_safe_bind

    for host in ("127.0.0.1", "localhost", "::1"):
        _check_safe_bind(host, oauth_enabled=False, allow_unauthenticated=False)


def test_safe_bind_refuses_unauthenticated_public_bind():
    """Non-loopback + no auth + no override must hard-fail before opening a port."""
    from clustr.server import _check_safe_bind

    with pytest.raises(SystemExit, match="Refusing to start"):
        _check_safe_bind("0.0.0.0", oauth_enabled=False, allow_unauthenticated=False)


def test_safe_bind_allows_public_with_override_or_oauth():
    """An explicit override, or enabled OAuth, permits a non-loopback bind."""
    from clustr.server import _check_safe_bind

    _check_safe_bind("0.0.0.0", oauth_enabled=False, allow_unauthenticated=True)
    _check_safe_bind("0.0.0.0", oauth_enabled=True, allow_unauthenticated=False)


def test_allow_unauthenticated_defaults_false():
    """The override must be off by default — fail closed."""
    env = {
        "PROXMOX_HOST": "192.168.1.1",
        "PROXMOX_USER": "root@pam",
        "PROXMOX_TOKEN_NAME": "clustr",
        "PROXMOX_TOKEN_VALUE": "test-secret",
    }
    with patch.dict(os.environ, env, clear=False):
        from clustr.config.settings import get_settings

        get_settings.cache_clear()
        settings = get_settings()
        assert settings.server.allow_unauthenticated is False
        get_settings.cache_clear()


def test_settings_defaults():
    """Settings load with minimum required env vars set."""
    env = {
        "PROXMOX_HOST": "192.168.1.1",
        "PROXMOX_USER": "root@pam",
        "PROXMOX_TOKEN_NAME": "clustr",
        "PROXMOX_TOKEN_VALUE": "test-secret",
    }
    with patch.dict(os.environ, env, clear=False):
        # Clear cache before test
        from clustr.config.settings import get_settings

        get_settings.cache_clear()
        settings = get_settings()

        assert settings.proxmox.host == "192.168.1.1"
        assert settings.proxmox.port == 8006
        assert settings.proxmox.verify_ssl is False
        assert settings.oauth.enabled is False
        assert settings.server.port == 8080
        get_settings.cache_clear()


def test_oauth_disabled_by_default():
    """OAuth must be disabled by default — no accidental auth bypass."""
    env = {
        "PROXMOX_HOST": "192.168.1.1",
        "PROXMOX_USER": "root@pam",
        "PROXMOX_TOKEN_NAME": "clustr",
        "PROXMOX_TOKEN_VALUE": "test-secret",
    }
    with patch.dict(os.environ, env, clear=False):
        from clustr.config.settings import get_settings

        get_settings.cache_clear()
        settings = get_settings()
        assert settings.oauth.enabled is False
        get_settings.cache_clear()


def test_oauth_can_be_enabled():
    """OAuth can be enabled via environment variable."""
    env = {
        "PROXMOX_HOST": "192.168.1.1",
        "PROXMOX_USER": "root@pam",
        "PROXMOX_TOKEN_NAME": "clustr",
        "PROXMOX_TOKEN_VALUE": "test-secret",
        "OAUTH_ENABLED": "true",
        "OAUTH_ISSUER": "https://auth.example.com",
    }
    with patch.dict(os.environ, env, clear=False):
        from clustr.config.settings import get_settings

        get_settings.cache_clear()
        settings = get_settings()
        assert settings.oauth.enabled is True
        assert settings.oauth.issuer == "https://auth.example.com"
        get_settings.cache_clear()
