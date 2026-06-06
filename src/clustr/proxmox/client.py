"""
Proxmox API client — thin wrapper around proxmoxer.

Provides a single authenticated connection instance and a small set of
helper methods used by the tool layer. All Proxmox API exceptions are
caught here and re-raised as ``ProxmoxError`` so the tool layer never
leaks raw proxmoxer internals to MCP callers.

Connection handling:
    The client is a lazily-built, lock-guarded singleton. If a call fails
    with a transient connection error (dropped socket, stale keep-alive,
    Proxmox restart), the helpers rebuild the connection once and retry —
    so a dead connection recovers without a server restart. Genuine API
    errors (auth, permission, 4xx/5xx) are NOT retried; retrying them would
    be pointless and, for mutations, unsafe.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from proxmoxer import ProxmoxAPI
from proxmoxer.core import ResourceException
from requests.exceptions import ConnectionError as RequestsConnectionError
from requests.exceptions import Timeout as RequestsTimeout

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


# ---------------------------------------------------------------------------
# Lock-guarded singleton connection
# ---------------------------------------------------------------------------
_client: ProxmoxAPI | None = None
_client_lock = threading.Lock()

# Transient failures that mean "the request likely never completed" — safe to
# rebuild the connection and retry once.
_RECOVERABLE_ERRORS = (
    RequestsConnectionError,
    RequestsTimeout,
    ConnectionError,
    OSError,
)


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
            f"Authentication failed: {exc}",
            status_code=getattr(exc, "status_code", None),
        ) from exc
    except Exception as exc:
        raise ProxmoxError(
            f"Cannot reach Proxmox at {s.host}:{s.port} — {exc}"
        ) from exc


def get_client() -> ProxmoxAPI:
    """
    Return the shared Proxmox API client, building it on first use.

    Raises ``ProxmoxError`` if the connection cannot be established.
    Thread-safe: the connection is built at most once even under concurrency.
    """
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = _build_client()
    return _client


def reset_client() -> None:
    """Drop the cached connection so the next call rebuilds it."""
    global _client
    with _client_lock:
        _client = None


def _call(path_fn: Any, kwargs: dict[str, Any]) -> Any:
    """
    Execute a proxmoxer call, translating exceptions to ``ProxmoxError`` and
    recovering once from transient connection failures.

    ``path_fn`` is a zero-arg callable that performs the proxmoxer call, e.g.::

        proxmox_get(lambda: get_client().nodes.get())

    Because ``path_fn`` calls ``get_client()`` itself, the retry path picks up
    a freshly rebuilt connection automatically.
    """
    try:
        return path_fn(**kwargs)
    except ResourceException as exc:
        # A real API response (auth/permission/4xx/5xx) — do not retry.
        raise ProxmoxError(
            str(exc), status_code=getattr(exc, "status_code", None)
        ) from exc
    except _RECOVERABLE_ERRORS as exc:
        logger.warning(
            "Proxmox connection error (%s); rebuilding connection and retrying " "once",
            exc,
        )
        reset_client()
        try:
            return path_fn(**kwargs)
        except ResourceException as exc2:
            raise ProxmoxError(
                str(exc2), status_code=getattr(exc2, "status_code", None)
            ) from exc2
        except Exception as exc2:
            raise ProxmoxError(f"Proxmox unreachable after reconnect: {exc2}") from exc2
    except ProxmoxError:
        raise
    except Exception as exc:
        raise ProxmoxError(f"Proxmox API error: {exc}") from exc


def proxmox_get(path_fn: Any, **kwargs: Any) -> Any:
    """Call a proxmoxer GET endpoint, translating exceptions to ProxmoxError."""
    return _call(path_fn, kwargs)


def proxmox_post(path_fn: Any, **kwargs: Any) -> Any:
    """Call a proxmoxer POST/mutating endpoint, translating exceptions."""
    return _call(path_fn, kwargs)
