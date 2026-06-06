"""
Host verification middleware — skeleton for future licensing / instance binding.

Currently a transparent pass-through. No logic executes.

When to activate:
    If Clustr is ever distributed as a SaaS-managed connector (rather than
    self-hosted), this middleware would verify that the Proxmox host MAC/UUID
    matches the registered license token before allowing tool calls.

    Implementation steps when ready:
    1. Generate a UUID binding token tied to the Proxmox host UUID at registration
    2. Store in settings (HOST_BINDING_TOKEN env var)
    3. Verify incoming requests carry the binding token
    4. Reject requests where the reported host UUID doesn't match

For now: every request passes through without modification.
"""

from __future__ import annotations

import logging

from starlette.types import ASGIApp, Receive, Scope, Send

logger = logging.getLogger(__name__)


class HostVerifyMiddleware:
    """
    ASGI middleware for host identity binding.

    Currently a no-op pass-through. Does not inspect requests.
    Safe to leave wired in permanently — zero overhead when inactive.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        logger.debug("HostVerifyMiddleware loaded (pass-through mode)")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # TODO: When licensing is implemented, validate HOST_BINDING_TOKEN here
        await self.app(scope, receive, send)
