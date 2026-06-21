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
 *
 * Hardening (the whole gate is one password, exposed to the internet):
 *  - /login is brute-force-resistant: each authorization allows only
 *    MAX_LOGIN_ATTEMPTS guesses before its login id is burned, and a global
 *    fixed-window throttle caps total attempts (per-IP limiting is useless
 *    behind a tunnel, where every request looks like 127.0.0.1).
 *  - Authorization codes are bound to the client they were issued to.
 *  - Refresh tokens are single-use (rotated) and expire.
 *  - A sweeper purges expired state so the in-memory maps can't grow without
 *    bound under unauthenticated traffic.
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
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CODE_TTL_MS = 60_000;
const LOGIN_TTL_MS = 10 * 60_000;
const MAX_LOGIN_ATTEMPTS = 5; // guesses allowed per authorization before the id is burned
const MAX_CLIENTS = 1000; // cap dynamic registrations (open endpoint)
const MAX_PENDING = 200; // cap in-flight /authorize logins (open endpoint, see authorize())
const SWEEP_INTERVAL_MS = 60_000;

// Global fixed-window throttles. Per-IP is meaningless behind a tunnel
// (cloudflared/tailscale connect from localhost), so these cap total throughput.
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_PER_WINDOW = 10; // password guesses/min globally (one shared secret)
const AUTHORIZE_MAX_PER_WINDOW = 60; // /authorize hits/min (each mints pending state)

const rand = (): string => randomBytes(32).toString("hex");
const now = (): number => Date.now();

function passwordMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface PendingLogin {
  clientId: string;
  clientName?: string;
  params: AuthorizationParams;
  attempts: number;
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
  expiresAt: number; // ms
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

  constructor(private readonly cfg: OAuthConfig) {
    // Purge expired state so unauthenticated traffic can't grow memory without
    // bound. unref() so it never keeps the process alive on its own.
    setInterval(() => this.sweep(), SWEEP_INTERVAL_MS).unref();
  }

  private sweep(): void {
    const t = now();
    for (const [k, v] of this.pending) if (v.expiresAt < t) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < t) this.codes.delete(k);
    for (const [k, v] of this.access) if (v.expiresAt < t) this.access.delete(k);
    for (const [k, v] of this.refresh) if (v.expiresAt < t) this.refresh.delete(k);
  }

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (id) => this.clients.get(id),
    registerClient: (client) => {
      // Open endpoint — cap total registrations, evicting the oldest if needed.
      if (this.clients.size >= MAX_CLIENTS) {
        const oldest = this.clients.keys().next().value;
        if (oldest) this.clients.delete(oldest);
      }
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
    // Open, unauthenticated endpoint: bound the pending map so a flood of
    // /authorize hits can't grow memory faster than the sweeper reclaims it.
    // Evict oldest (insertion-ordered Map) when at the cap.
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (!oldest) break;
      this.pending.delete(oldest);
    }
    const id = rand();
    this.pending.set(id, {
      clientId: client.client_id,
      clientName: client.client_name,
      params,
      attempts: 0,
      expiresAt: now() + LOGIN_TTL_MS,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      loginPage({
        loginId: id,
        clientName: client.client_name,
        redirectUri: params.redirectUri,
      }),
    );
  }

  /** Called by the POST /login route. Validates the password, mints a code, and
   *  redirects back to the client — or re-renders the form on failure. After
   *  MAX_LOGIN_ATTEMPTS wrong guesses the login id is burned (forces a fresh,
   *  rate-limited /authorize), which is what bounds brute-force. */
  completeLogin(loginId: string, password: string, res: Response): void {
    const p = this.pending.get(loginId);
    if (!p || p.expiresAt < now()) {
      this.pending.delete(loginId);
      res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(loginPage({ loginId: "", error: "Login expired — start again from Claude." }));
      return;
    }
    if (!passwordMatches(this.cfg.password, password)) {
      p.attempts += 1;
      if (p.attempts >= MAX_LOGIN_ATTEMPTS) {
        this.pending.delete(loginId); // burn it
        res.status(429).setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(loginPage({ loginId: "", error: "Too many attempts — start again from Claude." }));
        return;
      }
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        loginPage({
          loginId,
          clientName: p.clientName,
          redirectUri: p.params.redirectUri,
          error: "Incorrect password.",
        }),
      );
      return;
    }
    this.pending.delete(loginId);

    const code = rand();
    this.codes.set(code, {
      clientId: p.clientId, // bind the code to the client that started the flow
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
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const c = this.codes.get(authorizationCode);
    if (!c || c.expiresAt < now() || c.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
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
    // Bind to the redeeming client and consume regardless of outcome.
    this.codes.delete(authorizationCode); // single use
    if (!c || c.expiresAt < now() || c.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
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
    // Rotate: the presented refresh token is consumed whether or not it's valid.
    this.refresh.delete(refreshToken);
    if (!r || r.expiresAt < now() || r.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
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
      expiresAt: now() + REFRESH_TTL_MS,
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

/** Global fixed-window throttle for the /login endpoint (not per-IP — see note
 *  above). Exported pure so it's unit-testable. */
export function makeLoginThrottle(
  windowMs = LOGIN_WINDOW_MS,
  maxPerWindow = LOGIN_MAX_PER_WINDOW,
): () => boolean {
  let windowStart = 0;
  let count = 0;
  return () => {
    const t = now();
    if (t - windowStart > windowMs) {
      windowStart = t;
      count = 0;
    }
    count += 1;
    return count > maxPerWindow; // true => throttled
  };
}

/** HTML-escape untrusted values. `client_name` and `redirect_uri` come from
 *  open dynamic registration, so they MUST be escaped before display. */
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function loginPage(opts: {
  loginId: string;
  clientName?: string;
  redirectUri?: string;
  error?: string;
}): string {
  const { loginId, clientName, redirectUri, error } = opts;
  const err = error
    ? `<p style="color:#c0392b;margin:0 0 12px">${escapeHtml(error)}</p>`
    : "";

  // Consent: show *what* is asking and *where* it will send you back, so a
  // malicious client / crafted authorize link is visible before you type the
  // password. Both values are attacker-controllable → escaped.
  let consent = "";
  if (loginId) {
    const who = escapeHtml(clientName?.trim() || "An application");
    let where = "";
    if (redirectUri) {
      try {
        where = ` and return you to <strong>${escapeHtml(new URL(redirectUri).host)}</strong>`;
      } catch {
        /* malformed redirect_uri — omit the host line */
      }
    }
    consent =
      `<p style="color:#445;margin:0 0 16px;font-size:14px">` +
      `<strong>${who}</strong> wants to connect to your Proxmox${where}. ` +
      `Only continue if you started this from Claude.</p>`;
  }

  const form = loginId
    ? `<form method="post" action="login">
         <input type="hidden" name="login_id" value="${escapeHtml(loginId)}">
         <input type="password" name="password" placeholder="Password" autofocus
                style="width:100%;padding:10px;margin:0 0 12px;border:1px solid #ccc;border-radius:6px">
         <button type="submit"
                 style="width:100%;padding:10px;border:0;border-radius:6px;background:#2d6cdf;color:#fff;font-weight:600;cursor:pointer">
           Allow &amp; sign in
         </button>
       </form>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Clustr — Sign in</title></head>
    <body style="font-family:system-ui,sans-serif;background:#f4f6fb;margin:0">
      <div style="max-width:360px;margin:12vh auto;background:#fff;padding:28px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.08)">
        <h1 style="font-size:20px;margin:0 0 4px">Clustr</h1>
        <p style="color:#667;margin:0 0 18px">Sign in to connect your Proxmox.</p>
        ${consent}${err}${form}
      </div>
    </body></html>`;
}

/**
 * Mount the OAuth endpoints (authorize/token/register/revoke + metadata) and the
 * login form handler. Returns the provider (a token verifier) for the bearer
 * middleware.
 */
export function mountOAuth(
  app: Express,
  opts: { baseUrl: URL; config: OAuthConfig },
): { provider: ClustrOAuthProvider } {
  const provider = new ClustrOAuthProvider(opts.config);

  // Throttle /authorize before the SDK router handles it: each call mints
  // unauthenticated pending state, so cap the rate (the map is also capped).
  const authorizeThrottle = makeLoginThrottle(LOGIN_WINDOW_MS, AUTHORIZE_MAX_PER_WINDOW);
  app.use((req: Request, res: Response, next: express.NextFunction) => {
    if (req.path === "/authorize" && authorizeThrottle()) {
      res.status(429).type("text/plain").send("Too many authorization requests — retry shortly.");
      return;
    }
    next();
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: opts.baseUrl,
      resourceServerUrl: opts.baseUrl,
      resourceName: "Clustr (Proxmox)",
      scopesSupported: ["clustr"],
    }),
  );

  // The login form posts here. Global throttle in front of the password check.
  const throttled = makeLoginThrottle();
  app.post(
    "/login",
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      if (throttled()) {
        res.status(429).setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(
          loginPage({ loginId: "", error: "Too many attempts — wait a minute and retry." }),
        );
        return;
      }
      const loginId = String(req.body?.login_id ?? "");
      const password = String(req.body?.password ?? "");
      provider.completeLogin(loginId, password, res);
    },
  );

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
