"""
Shared helpers for Clustr tool modules.

``safe`` wraps a tool body so that no exception ever escapes to the MCP
caller — every error becomes actionable text instead. Proxmox-level errors
are surfaced verbatim; anything unexpected is logged and reported generically.
"""
from __future__ import annotations

import logging
from typing import Callable, TypeVar

from clustr.proxmox.client import ProxmoxError

logger = logging.getLogger(__name__)

T = TypeVar("T")


def safe(label: str, fn: Callable[[], str]) -> str:
    """
    Run a tool thunk, converting any failure into actionable text.

    ``label`` is the tool name, used only for logging/diagnostics.
    """
    try:
        return fn()
    except ProxmoxError as exc:
        logger.error("Proxmox error in %s: %s", label, exc)
        return f"Proxmox error: {exc}"
    except Exception as exc:  # noqa: BLE001 — deliberate catch-all boundary
        logger.exception("Unhandled error in tool '%s'", label)
        return f"Internal error in '{label}': {exc}"
