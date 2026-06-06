"""
Proxmox API client — thin wrapper around proxmoxer.

Provides a single authenticated connection instance and a small set of
helper methods used by the tool layer. All Proxmox API exceptions are
caught here and re-raised as ``ProxmoxError`` so the tool layer never
leaks raw proxmoxer internals to MCP callers.
"""
from __future__ import annotations

import logging
from functools import lru_cache
from typing import Any

from proxmoxer import ProxmoxAPI
from proxmoxer.core import ResourceException

from clustr.config.settings import get_settings

logger = logging.getLogger(__name__)


class ProxmoxError(Exception):
    """Raised when the Proxmox API returns an error or is unreachable."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code

    def to_mcp_error(self) -> dict[str, str]:
        """Return a structured dict suitable for MCP tool error responses."""
        return {
            "error": str(self),
            "status_code": str(self.status_code) if self.status_code else "unknown",
        }


def _build_client() -> ProxmoxAPI:
    """Construct and return a ProxmoxAPI instance from current settings."""
    s = get_settings().proxmox
    logger.info("Connecting to Proxmox at %s:%s as %s", s.host, s.port, s.user)
    try:
        client = ProxmoxAPI(
            s.host,
            port=s.port,
            user=s.user,
            token_name=s.token_name,
            token_value=s.token_value,
            verify_ssl=s.verify_ssl,
        )
        # Validate credentials immediately by fetching version
        client.version.get()
        logger.info("Proxmox connection established")
        return client
    except ResourceException as exc:
        raise ProxmoxError(
            f"Authentication failed: {exc}", status_code=getattr(exc, "status_code", None)
        ) from exc
    except Exception as exc:
        raise ProxmoxError(f"Cannot reach Proxmox at {s.host}:{s.port} — {exc}") from exc


@lru_cache(maxsize=1)
def get_client() -> ProxmoxAPI:
    """
    Return the cached Proxmox API client.

    Raises ``ProxmoxError`` on first call if the connection cannot be
    established. Subsequent calls return the cached instance.
    """
    return _build_client()


# ---------------------------------------------------------------------------
# Convenience helpers used across multiple tool modules
# ---------------------------------------------------------------------------

def proxmox_get(path_fn: Any, **kwargs: Any) -> Any:
    """
    Call a proxmoxer GET endpoint, translating exceptions to ProxmoxError.

    ``path_fn`` should be a callable that accepts no args and returns the
    result of a proxmoxer ``.get()`` call, e.g.::

        proxmox_get(lambda: get_client().nodes.get())

    This pattern keeps callers readable while centralising error handling.
    """
    try:
        return path_fn(**kwargs)
    except ResourceException as exc:
        raise ProxmoxError(str(exc), status_code=getattr(exc, "status_code", None)) from exc
    except Exception as exc:
        raise ProxmoxError(f"Proxmox API error: {exc}") from exc


def proxmox_post(path_fn: Any, **kwargs: Any) -> Any:
    """Call a proxmoxer POST/mutating endpoint, translating exceptions."""
    try:
        return path_fn(**kwargs)
    except ResourceException as exc:
        raise ProxmoxError(str(exc), status_code=getattr(exc, "status_code", None)) from exc
    except Exception as exc:
        raise ProxmoxError(f"Proxmox API error: {exc}") from exc
