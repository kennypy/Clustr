"""
OAuth 2.1 + PKCE middleware for Clustr.

When ``OAUTH_ENABLED=false`` (the default) this module is a complete
no-op — every request passes through without any token validation.
No OAuth libraries are invoked and no network calls are made.

When ``OAUTH_ENABLED=true`` the middleware validates Bearer tokens
against the configured JWKS endpoint, enforcing:
  - RS256 / ES256 signature validation
  - ``aud`` claim matches ``OAUTH_AUDIENCE``
  - Token expiry (``exp`` claim)

To activate, set in your .env:
    OAUTH_ENABLED=true
    OAUTH_ISSUER=https://your-auth-server.example.com
    OAUTH_CLIENT_ID=clustr
    OAUTH_AUDIENCE=clustr-mcp

Anthropic directory requirement:
    OAuth 2.1 with PKCE is required for connectors that access
    private user data. This skeleton is structured to meet that
    requirement with minimal changes when you are ready to submit.

    Required before submission:
    - Wire a real OAuth provider (Clerk, Auth0, or self-hosted)
    - Host /.well-known/oauth-protected-resource on your MCP domain
    - Provide test credentials to Anthropic reviewers
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from fastapi import Request, status
from fastapi.responses import Response
from starlette.types import ASGIApp, Receive, Scope, Send

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------
NextCallable = Callable[[Request], Awaitable[Response]]


# ---------------------------------------------------------------------------
# JWKS cache (populated lazily when OAuth is enabled)
# ---------------------------------------------------------------------------
_jwks_cache: dict[str, Any] | None = None


async def _fetch_jwks(jwks_uri: str) -> dict[str, Any]:
    """Fetch and cache the JWKS document from the OAuth provider."""
    global _jwks_cache
    if _jwks_cache is not None:
        return _jwks_cache
    try:
        import httpx

        async with httpx.AsyncClient() as client:
            resp = await client.get(jwks_uri, timeout=10)
            resp.raise_for_status()
            _jwks_cache = resp.json()
            logger.info("JWKS fetched from %s", jwks_uri)
            return _jwks_cache
    except Exception as exc:
        raise RuntimeError(f"Failed to fetch JWKS from {jwks_uri}: {exc}") from exc


async def _discover_jwks_uri(issuer: str) -> str:
    """Auto-discover JWKS URI from the issuer's OpenID Connect metadata."""
    try:
        import httpx

        discovery_url = f"{issuer.rstrip('/')}/.well-known/openid-configuration"
        async with httpx.AsyncClient() as client:
            resp = await client.get(discovery_url, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            return str(data["jwks_uri"])
    except Exception as exc:
        raise RuntimeError(f"OIDC discovery failed for issuer {issuer}: {exc}") from exc


async def _validate_token(token: str, settings_oauth: object) -> dict[str, Any]:
    """
    Validate a Bearer token and return its claims.

    TODO: Replace stub with full validation when wiring a real provider.
    Currently raises NotImplementedError to make it obvious this needs
    completing before the OAuth path is production-ready.
    """
    # TODO: Implement full JWT validation:
    #   1. Fetch JWKS via _fetch_jwks()
    #   2. Decode JWT header to identify kid
    #   3. Verify signature with matching JWK
    #   4. Validate exp, aud, iss claims
    #   5. Return decoded payload
    raise NotImplementedError(
        "OAuth token validation is not yet implemented. "
        "Set OAUTH_ENABLED=false or complete the TODO in auth/oauth.py."
    )


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------


class OAuthMiddleware:
    """
    ASGI middleware that enforces OAuth Bearer token validation.

    Behaviour:
      - OAUTH_ENABLED=false  → transparent pass-through, zero overhead
      - OAUTH_ENABLED=true   → validates Authorization: Bearer <token>
                               on every request to /mcp/*

    Paths excluded from auth even when enabled:
      - /.well-known/*   (OAuth metadata endpoints)
      - /health          (liveness probe)
    """

    EXCLUDED_PATHS = ("/.well-known/", "/health")

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        from clustr.config.settings import get_settings

        self._oauth_enabled = get_settings().oauth.enabled
        if self._oauth_enabled:
            logger.warning(
                "OAuth is ENABLED — token validation is STUBBED. "
                "Complete auth/oauth.py before production use."
            )
        else:
            logger.info("OAuth is disabled — pass-through mode active")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not self._oauth_enabled:
            # Fast path: bypass all OAuth logic entirely
            await self.app(scope, receive, send)
            return

        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path: str = scope.get("path", "")

        # Skip excluded paths
        if any(path.startswith(excluded) for excluded in self.EXCLUDED_PATHS):
            await self.app(scope, receive, send)
            return

        # Extract Bearer token
        headers = dict(scope.get("headers", []))
        auth_header = headers.get(b"authorization", b"").decode("utf-8")

        if not auth_header.startswith("Bearer "):
            from starlette.responses import JSONResponse

            response = JSONResponse(
                {
                    "error": "missing_token",
                    "detail": "Authorization: Bearer <token> required",
                },
                status_code=status.HTTP_401_UNAUTHORIZED,
                headers={"WWW-Authenticate": "Bearer"},
            )
            await response(scope, receive, send)
            return

        token = auth_header[len("Bearer ") :]

        try:
            from clustr.config.settings import get_settings

            await _validate_token(token, get_settings().oauth)
        except NotImplementedError as exc:
            # Stub not yet implemented — fail loudly so it can't silently pass
            from starlette.responses import JSONResponse

            response = JSONResponse(
                {"error": "oauth_not_implemented", "detail": str(exc)},
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
            )
            await response(scope, receive, send)
            return
        except Exception as exc:
            from starlette.responses import JSONResponse

            response = JSONResponse(
                {"error": "invalid_token", "detail": str(exc)},
                status_code=status.HTTP_401_UNAUTHORIZED,
                headers={"WWW-Authenticate": 'Bearer error="invalid_token"'},
            )
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)
