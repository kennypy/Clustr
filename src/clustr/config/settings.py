"""
Clustr configuration — loaded once at startup from environment / .env file.
All other modules import `get_settings()` rather than reading env directly.
"""
from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class ProxmoxSettings(BaseSettings):
    """Proxmox connection parameters."""

    host: str = Field(..., description="Proxmox node IP or hostname")
    port: int = Field(8006, ge=1, le=65535)
    user: str = Field(..., description="Proxmox user, e.g. root@pam")
    token_name: str = Field(..., description="API token name")
    token_value: str = Field(..., description="API token secret")
    verify_ssl: bool = Field(False, description="Verify TLS certificate")

    model_config = SettingsConfigDict(env_prefix="PROXMOX_")


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

    model_config = SettingsConfigDict(env_prefix="OAUTH_")


class ServerSettings(BaseSettings):
    """HTTP server settings."""

    host: str = Field("0.0.0.0")
    port: int = Field(8080, ge=1, le=65535)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = Field("INFO")

    model_config = SettingsConfigDict(env_prefix="MCP_")


class Settings(BaseSettings):
    """Root settings — aggregates all sub-settings."""

    proxmox: ProxmoxSettings = Field(default_factory=ProxmoxSettings)
    oauth: OAuthSettings = Field(default_factory=OAuthSettings)
    server: ServerSettings = Field(default_factory=ServerSettings)

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @field_validator("proxmox", mode="before")
    @classmethod
    def _build_proxmox(cls, v: object) -> object:
        # Allow nested dict or already-constructed model
        return v


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the singleton settings instance (cached after first call)."""
    return Settings()
