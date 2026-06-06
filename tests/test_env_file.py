"""
Regression test: settings must load from a real .env file on disk, not only
from process environment variables.

This guards the bug where nested settings models (Proxmox/OAuth/Server) read
os.environ but ignored the .env file, crashing the documented
``cp .env.example .env && clustr`` workflow.
"""
import pytest

# Every env var that could shadow the .env file and mask a regression.
_SHADOW_VARS = [
    "PROXMOX_HOST", "PROXMOX_PORT", "PROXMOX_USER", "PROXMOX_TOKEN_NAME",
    "PROXMOX_TOKEN_VALUE", "PROXMOX_VERIFY_SSL",
    "MCP_HOST", "MCP_PORT", "MCP_LOG_LEVEL", "MCP_PUBLIC_URL",
    "OAUTH_ENABLED", "OAUTH_ISSUER",
]


def test_settings_load_from_dotenv_file(tmp_path, monkeypatch):
    # Ensure nothing in the real environment shadows the file.
    for var in _SHADOW_VARS:
        monkeypatch.delenv(var, raising=False)

    env_file = tmp_path / ".env"
    env_file.write_text(
        "PROXMOX_HOST=10.0.0.9\n"
        "PROXMOX_USER=root@pam\n"
        "PROXMOX_TOKEN_NAME=clustr\n"
        "PROXMOX_TOKEN_VALUE=secret-from-file\n"
        "MCP_PORT=9099\n"
        "MCP_PUBLIC_URL=https://clustr.example.com\n"
        "OAUTH_ENABLED=true\n"
        "OAUTH_ISSUER=https://auth.example.com\n"
    )

    # pydantic-settings reads ".env" relative to the working directory.
    monkeypatch.chdir(tmp_path)

    from clustr.config.settings import get_settings
    get_settings.cache_clear()
    try:
        settings = get_settings()
        assert settings.proxmox.host == "10.0.0.9"
        assert settings.proxmox.token_value == "secret-from-file"
        assert settings.server.port == 9099
        assert settings.server.public_url == "https://clustr.example.com"
        assert settings.oauth.enabled is True
        assert settings.oauth.issuer == "https://auth.example.com"
    finally:
        get_settings.cache_clear()


def test_server_host_defaults_to_loopback(tmp_path, monkeypatch):
    """Default bind address must be 127.0.0.1, not 0.0.0.0."""
    for var in _SHADOW_VARS:
        monkeypatch.delenv(var, raising=False)

    env_file = tmp_path / ".env"
    env_file.write_text(
        "PROXMOX_HOST=10.0.0.9\n"
        "PROXMOX_USER=root@pam\n"
        "PROXMOX_TOKEN_NAME=clustr\n"
        "PROXMOX_TOKEN_VALUE=secret\n"
    )
    monkeypatch.chdir(tmp_path)

    from clustr.config.settings import get_settings
    get_settings.cache_clear()
    try:
        settings = get_settings()
        assert settings.server.host == "127.0.0.1"
        # And no resource is published when MCP_PUBLIC_URL is unset.
        assert settings.server.public_url == ""
    finally:
        get_settings.cache_clear()
