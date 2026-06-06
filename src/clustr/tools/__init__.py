"""
Shared helpers for Clustr tool modules.

``safe`` wraps a tool body so that no exception ever escapes to the MCP
caller — every error becomes actionable text instead. Proxmox-level errors
are surfaced verbatim; anything unexpected is logged and reported generically.

It also offloads the (synchronous, blocking) proxmoxer work to a worker
thread via ``anyio.to_thread``. Tool functions are ``async`` so FastMCP can
await them; running the blocking call in a thread keeps the event loop free
to serve other requests concurrently.
"""

from __future__ import annotations

import logging
from typing import Callable

import anyio

from clustr.proxmox.client import ProxmoxError

logger = logging.getLogger(__name__)


async def safe(label: str, fn: Callable[[], str]) -> str:
    """
    Run a blocking tool thunk in a worker thread, converting any failure
    into actionable text.

    ``label`` is the tool name, used only for logging/diagnostics.
    """
    try:
        return await anyio.to_thread.run_sync(fn)
    except ProxmoxError as exc:
        logger.error("Proxmox error in %s: %s", label, exc)
        return f"Proxmox error: {exc}"
    except Exception as exc:  # noqa: BLE001 — deliberate catch-all boundary
        logger.exception("Unhandled error in tool '%s'", label)
        return f"Internal error in '{label}': {exc}"
