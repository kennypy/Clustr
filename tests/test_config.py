"""Tests for configuration loading."""

import os
from unittest.mock import patch


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
