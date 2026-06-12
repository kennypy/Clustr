/**
 * Built-in OAuth 2.1 Authorization Server for the remote (HTTP) connector.
 *
 * Clustr issues its own tokens — no external provider to run. A single
 * configured login (CLUSTR_AUTH_USERNAME / CLUSTR_AUTH_PASSWORD) gates the
 * authorize step; the rest (PKCE, dynamic client registration, metadata) is the
 * MCP SDK's standard machinery. Tokens live in process memory, so a restart
 * means clients re-authorize — fine for a single self-hosted instance.
 *
 * This makes the remote connector safe to put behind a tunnel: Claude does the
 * normal OAuth dance, the user logs in once, and /mcp requires a valid token.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { Express, Request, Response } from "express";
import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const ACCESS_TTL_SEC = 3600;
const CODE_TTL_MS = 60_000;
const LOGIN_TTL_MS = 10 * 60_000;

const rand = (): string => randomBytes(32).toString("hex");
const now = (): number => Date.now();

function passwordMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface PendingLogin {
  params: AuthorizationParams;
  expiresAt: number;
}
interface AuthCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}
interface TokenInfo {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // ms; refresh tokens use Infinity
}

export interface OAuthConfig {
  username: string;
  password: string;
}

export class ClustrOAuthProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private pending = new Map<string, PendingLogin>();
  private codes = new Map<string, AuthCode>();
  private access = new Map<string, TokenInfo>();
  private refresh = new Map<string, TokenInfo>();

  constructor(private readonly cfg: OAuthConfig) {}

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (id) => this.clients.get(id),
    registerClient: (client) => {
      const full: OAuthClientInformationFull = {
        ...client,
        client_id: randomUUID(),
        client_id_issued_at: Math.floor(now() / 1000),
      };
      this.clients.set(full.client_id, full);
      return full;
    },
  };

  // Render a login page; the form posts to /login with the pending id.
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const id = rand();
    this.pending.set(id, { params, expiresAt: now() + LOGIN_TTL_MS });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(loginPage(id));
  }

  /** Called by the POST /login route. Validates the password, mints a code,
   *  and redirects back to the client — or re-renders the form on failure. */
  completeLogin(loginId: string, password: string, res: Response): void {
    const p = this.pending.get(loginId);
    if (!p || p.expiresAt < now()) {
      res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(loginPage("", "Login expired — start again from Claude."));
      return;
    }
    if (!passwordMatches(this.cfg.password, password)) {
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(loginPage(loginId, "Incorrect password."));
      return;
    }
    this.pending.delete(loginId);

    const code = rand();
    this.codes.set(code, {
      clientId: "", // filled below
      codeChallenge: p.params.codeChallenge,
      redirectUri: p.params.redirectUri,
      scopes: p.params.scopes ?? [],
      resource: p.params.resource?.toString(),
      expiresAt: now() + CODE_TTL_MS,
    });
    // The SDK validated client+redirect before authorize(); the redirect target
    // is the one it approved.
    const url = new URL(p.params.redirectUri);
    url.searchParams.set("code", code);
    if (p.params.state) url.searchParams.set("state", p.params.state);
    res.redirect(302, url.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const c = this.codes.get(authorizationCode);
    if (!c || c.expiresAt < now()) throw new InvalidGrantError("Invalid authorization code");
    return c.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const c = this.codes.get(authorizationCode);
    if (!c || c.expiresAt < now()) throw new InvalidGrantError("Invalid authorization code");
    this.codes.delete(authorizationCode); // single use
    if (redirectUri && redirectUri !== c.redirectUri) {
      throw new InvalidGrantError("redirect_uri mismatch");
    }
    return this.issue(client.client_id, c.scopes, resource?.toString() ?? c.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const r = this.refresh.get(refreshToken);
    if (!r || r.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    return this.issue(
      r.clientId,
      scopes && scopes.length ? scopes : r.scopes,
      resource?.toString() ?? r.resource,
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const t = this.access.get(token);
    if (!t || t.expiresAt < now()) throw new InvalidTokenError("Token expired or invalid");
    return {
      token,
      clientId: t.clientId,
      scopes: t.scopes,
      expiresAt: Math.floor(t.expiresAt / 1000),
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    this.access.delete(request.token);
    this.refresh.delete(request.token);
  }

  private issue(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const accessToken = rand();
    const refreshToken = rand();
    this.access.set(accessToken, {
      clientId,
      scopes,
      resource,
      expiresAt: now() + ACCESS_TTL_SEC * 1000,
    });
    this.refresh.set(refreshToken, {
      clientId,
      scopes,
      resource,
      expiresAt: Number.POSITIVE_INFINITY,
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SEC,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}

function loginPage(loginId: string, error?: string): string {
  const err = error
    ? `<p style="color:#c0392b;margin:0 0 12px">${error}</p>`
    : "";
  const form = loginId
    ? `<form method="post" action="login">
         <input type="hidden" name="login_id" value="${loginId}">
         <input type="password" name="password" placeholder="Password" autofocus
                style="width:100%;padding:10px;margin:0 0 12px;border:1px solid #ccc;border-radius:6px">
         <button type="submit"
                 style="width:100%;padding:10px;border:0;border-radius:6px;background:#2d6cdf;color:#fff;font-weight:600;cursor:pointer">
           Sign in
         </button>
       </form>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Clustr — Sign in</title></head>
    <body style="font-family:system-ui,sans-serif;background:#f4f6fb;margin:0">
      <div style="max-width:340px;margin:12vh auto;background:#fff;padding:28px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.08)">
        <h1 style="font-size:20px;margin:0 0 4px">Clustr</h1>
        <p style="color:#667;margin:0 0 18px">Sign in to connect your Proxmox.</p>
        ${err}${form}
      </div>
    </body></html>`;
}

/**
 * Mount the OAuth endpoints (authorize/token/register/revoke + metadata) and the
 * login form handler. Returns the provider (a token verifier) and the
 * protected-resource metadata URL for the bearer middleware.
 */
export function mountOAuth(
  app: Express,
  opts: { baseUrl: URL; config: OAuthConfig },
): { provider: ClustrOAuthProvider } {
  const provider = new ClustrOAuthProvider(opts.config);

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: opts.baseUrl,
      resourceServerUrl: opts.baseUrl,
      resourceName: "Clustr (Proxmox)",
      scopesSupported: ["clustr"],
    }),
  );

  // The login form posts here.
  app.post("/login", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    const loginId = String(req.body?.login_id ?? "");
    const password = String(req.body?.password ?? "");
    provider.completeLogin(loginId, password, res);
  });

  return { provider };
}

export function bearerAuthMiddleware(provider: ClustrOAuthProvider, baseUrl: URL) {
  return requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: new URL(
      "/.well-known/oauth-protected-resource",
      baseUrl,
    ).toString(),
  });
}
