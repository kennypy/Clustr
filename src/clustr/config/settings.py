"""
Clustr configuration — loaded once at startup from environment / .env file.
All other modules import `get_settings()` rather than reading env directly.
"""

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class ProxmoxSettings(BaseSettings):
    """Proxmox connection parameters."""

    host: str = Field(..., description="Proxmox node IP or hostname")
    port: int = Field(8006, ge=1, le=65535)
    user: str = Field(..., description="Proxmox user, e.g. root@pam")
    token_name: str = Field(..., description="API token name")
    token_value: str = Field(..., description="API token secret")
    verify_ssl: bool = Field(False, description="Verify TLS certificate")

    model_config = SettingsConfigDict(
        env_prefix="PROXMOX_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


class OAuthSettings(BaseSettings):
    """
    OAuth 2.1 + PKCE configuration.

    When ``enabled=False`` (the default) the OAuth middleware is a transparent
    pass-through — no tokens are checked and no OAuth libraries are exercised.
    Flip to ``true`` only when you have a real provider configured.
    """

    enabled: bool = Field(False)
    issuer: str = Field("", description="OAuth issuer URL")
    client_id: str = Field("clustr")
    client_secret: str = Field("")
    audience: str = Field("clustr-mcp")
    jwks_uri: str = Field(
        "",
        description="Override JWKS URI; auto-discovered from issuer if empty",
    )

    model_config = SettingsConfigDict(
        env_prefix="OAUTH_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


class ServerSettings(BaseSettings):
    """HTTP server settings."""

    host: str = Field("127.0.0.1")
    port: int = Field(8080, ge=1, le=65535)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = Field("INFO")
    public_url: str = Field(
        "",
        description=(
            "Public, canonical base URL of this MCP server (e.g. "
            "https://clustr.example.com). Used in OAuth protected-resource "
            "metadata. Leave empty in non-public deployments."
        ),
    )

    model_config = SettingsConfigDict(
        env_prefix="MCP_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


class Settings(BaseSettings):
    """Root settings — aggregates all sub-settings."""

    # default_factory builds each sub-model from the environment / .env at
    # runtime; mypy can't see the required fields are env-populated, so the
    # zero-arg construction is flagged — safe to ignore here.
    proxmox: ProxmoxSettings = Field(default_factory=ProxmoxSettings)  # type: ignore[arg-type]
    oauth: OAuthSettings = Field(default_factory=OAuthSettings)  # type: ignore[arg-type]
    server: ServerSettings = Field(default_factory=ServerSettings)  # type: ignore[arg-type]

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the singleton settings instance (cached after first call)."""
    return Settings()
