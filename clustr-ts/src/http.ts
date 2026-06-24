/**
 * Streamable HTTP transport: lets the full tool set run as a *remote* MCP
 * connector (added to claude.ai / mobile), not just the local stdio extension.
 *
 * Loaded only when HTTP mode is selected, so the stdio/desktop path never pulls
 * in Express. Stateful sessions (one server instance per MCP session).
 *
 * Auth: if a login password is configured, the built-in OAuth server protects
 * /mcp (Bearer tokens). Safe to expose behind a tunnel. Without a password it
 * binds 127.0.0.1 and REFUSES a non-loopback bind unless explicitly overridden.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import express, { type Request, type Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { bearerAuthMiddleware, mountOAuth, type OAuthConfig } from "./oauth.js";
import { LOGO_SVG } from "./branding.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);
const MAX_SESSIONS = 256;

// Raster brand mark, loaded once. dist/http.js sits one level under the package
// root, so icon.png is one directory up. Optional: missing it just means no
// raster favicon (the SVG one still serves).
const ICON_PNG: Buffer | null = (() => {
  try {
    return readFileSync(new URL("../icon.png", import.meta.url));
  } catch {
    return null;
  }
})();

/**
 * Wrap a PNG as a single-image .ico. Clients that fetch `/favicon.ico` for the
 * connector/tab icon expect ICO bytes, not SVG; modern renderers accept a PNG
 * payload inside the ICO container ("PNG-in-ICO").
 */
function pngToIco(png: Buffer): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0); // width 0 => 256+
  entry.writeUInt8(0, 1); // height 0 => 256+
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // image size
  entry.writeUInt32LE(22, 12); // offset (6 + 16)
  return Buffer.concat([header, entry, png]);
}

const ICON_ICO: Buffer | null = ICON_PNG ? pngToIco(ICON_PNG) : null;

export function assertSafeBind(
  host: string,
  allowUnauthenticated: boolean,
  authEnabled: boolean,
): void {
  if (LOOPBACK.has(host) || allowUnauthenticated || authEnabled) return;
  throw new Error(
    `Refusing to start HTTP on ${host}: no app-level authentication. Set a login ` +
      "(CLUSTR_AUTH_PASSWORD) to enable the built-in OAuth, or bind 127.0.0.1 and " +
      "put an authenticating proxy/tunnel in front, or set " +
      "CLUSTR_ALLOW_UNAUTHENTICATED=true to acknowledge an external front door.",
  );
}

export interface HttpOptions {
  host: string;
  port: number;
  allowUnauthenticated: boolean;
  allowedHosts: string[];
  auth: OAuthConfig | null;
  publicUrl: string;
}

export async function runHttp(
  buildServer: () => McpServer,
  opts: HttpOptions,
): Promise<void> {
  const authEnabled = !!opts.auth?.password;
  assertSafeBind(opts.host, opts.allowUnauthenticated, authEnabled);

  // The whole remote gate is one shared password exposed to the internet. The
  // /login throttle bounds guess rate, but a weak secret is still the weak link.
  if (authEnabled && (opts.auth!.password.length < 12)) {
    console.error(
      "WARNING: CLUSTR_AUTH_PASSWORD is short (<12 chars). It's the single secret " +
        "protecting your whole cluster over the internet: use a long, random " +
        "passphrase.",
    );
  }

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "clustr", auth: authEnabled ? "oauth" : "none" });
  });

  // Brand mark, served in every shape a client might fetch for the connector
  // card / browser tab: SVG, PNG, apple-touch, and a real .ico. Public and
  // cacheable; it's just a logo.
  const CACHE = "public, max-age=86400";
  app.get("/favicon.svg", (_req: Request, res: Response) => {
    res.type("image/svg+xml").set("Cache-Control", CACHE).send(LOGO_SVG);
  });
  const sendPng = (_req: Request, res: Response): void => {
    if (!ICON_PNG) {
      res.type("image/svg+xml").set("Cache-Control", CACHE).send(LOGO_SVG);
      return;
    }
    res.type("image/png").set("Cache-Control", CACHE).send(ICON_PNG);
  };
  app.get("/favicon.png", sendPng);
  app.get("/icon.png", sendPng);
  app.get("/apple-touch-icon.png", sendPng);
  app.get("/apple-touch-icon-precomposed.png", sendPng);
  app.get("/favicon.ico", (req: Request, res: Response) => {
    if (ICON_ICO) {
      res.type("image/x-icon").set("Cache-Control", CACHE).send(ICON_ICO);
      return;
    }
    res.type("image/svg+xml").set("Cache-Control", CACHE).send(LOGO_SVG);
  });

  // A tiny branded landing page at the root so clients that scrape the origin
  // for `<link rel=icon>` (a common way connector cards source an icon) find it,
  // and so a human hitting the URL sees Clustr rather than a 404. /mcp is the
  // actual endpoint; nothing sensitive lives here.
  app.get("/", (_req: Request, res: Response) => {
    res
      .type("html")
      .set("Cache-Control", CACHE)
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<link rel="icon" type="image/svg+xml" href="/favicon.svg">` +
          `<link rel="icon" type="image/png" sizes="512x512" href="/favicon.png">` +
          `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` +
          `<title>Clustr</title></head>` +
          `<body style="font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;` +
          `display:grid;place-items:center;min-height:100vh;margin:0;text-align:center">` +
          `<main><img src="/favicon.svg" alt="Clustr" width="96" height="96" style="border-radius:22px">` +
          `<h1 style="margin:16px 0 4px">Clustr</h1>` +
          `<p style="color:#94a3b8;margin:0">Proxmox MCP connector. Add this URL in Claude with the ` +
          `<code>/mcp</code> path.</p></main></body></html>`,
      );
  });

  // Public base URL used as the OAuth issuer / resource id. Behind a tunnel this
  // must be the public HTTPS URL (CLUSTR_PUBLIC_URL); otherwise we derive a local one.
  const displayHost = opts.host === "0.0.0.0" ? "127.0.0.1" : opts.host;
  const baseUrl = new URL(opts.publicUrl?.trim() || `http://${displayHost}:${opts.port}`);

  let bearer: express.RequestHandler[] = [];
  if (authEnabled) {
    const { provider } = mountOAuth(app, { baseUrl, config: opts.auth! });
    bearer = [bearerAuthMiddleware(provider, baseUrl)];
  }

  // DNS-rebinding protection for /mcp. If the operator didn't pin hosts
  // explicitly, default to the public URL's host (which is exactly the Host a
  // legitimate client sends), so it's on by default behind a tunnel.
  let allowedHosts = opts.allowedHosts;
  if (allowedHosts.length === 0 && opts.publicUrl) {
    try {
      allowedHosts = [new URL(opts.publicUrl).host];
    } catch {
      /* malformed CLUSTR_PUBLIC_URL, leave unset rather than break startup */
    }
  }

  // One transport per session, kept by session id.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const postHandler = async (req: Request, res: Response): Promise<void> => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport = sid ? transports.get(sid) : undefined;

    if (!transport) {
      if (sid || !isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid session" },
          id: null,
        });
        return;
      }
      // Cap concurrent sessions so a client can't exhaust memory by opening
      // sessions without ever closing them. Sessions are freed on close.
      if (transports.size >= MAX_SESSIONS) {
        res.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Too many active sessions; retry later." },
          id: null,
        });
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        allowedHosts: allowedHosts.length ? allowedHosts : undefined,
        onsessioninitialized: (id) => {
          transports.set(id, transport!);
        },
        onsessionclosed: (id) => {
          transports.delete(id);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      await buildServer().connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  };

  const bySession = async (req: Request, res: Response): Promise<void> => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing session id");
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.post("/mcp", ...bearer, postHandler);
  app.get("/mcp", ...bearer, bySession);
  app.delete("/mcp", ...bearer, bySession);

  await new Promise<void>((resolve) => {
    app.listen(opts.port, opts.host, () => {
      console.error(
        `Clustr HTTP transport on ${opts.host}:${opts.port}/mcp ` +
          `(auth: ${authEnabled ? "OAuth" : "NONE"})`,
      );
      if (!LOOPBACK.has(opts.host) && !authEnabled) {
        console.error(
          "WARNING: non-loopback with no app-level auth. Ensure a front door authenticates.",
        );
      }
      if (authEnabled && !opts.publicUrl) {
        console.error(
          "NOTE: CLUSTR_PUBLIC_URL not set; OAuth metadata advertises " +
            `${baseUrl.origin}. Behind a tunnel, set CLUSTR_PUBLIC_URL to the public HTTPS URL.`,
        );
      }
      resolve();
    });
  });
}
