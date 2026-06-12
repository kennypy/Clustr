/**
 * Streamable HTTP transport — lets the full tool set run as a *remote* MCP
 * connector (added to claude.ai / mobile), not just the local stdio extension.
 *
 * Loaded only when HTTP mode is selected, so the stdio/desktop path never pulls
 * in Express. Stateful sessions (one server instance per MCP session).
 *
 * Auth note: there is NO app-level auth yet (OAuth is the next step). So this
 * binds 127.0.0.1 by default and REFUSES a non-loopback bind unless something
 * else authenticates in front (acknowledged via CLUSTR_ALLOW_UNAUTHENTICATED).
 * The intended deployment is behind a tunnel + an authenticating front door.
 */

import { randomUUID } from "node:crypto";

import express, { type Request, type Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);

export function assertSafeBind(host: string, allowUnauthenticated: boolean): void {
  if (LOOPBACK.has(host) || allowUnauthenticated) return;
  throw new Error(
    `Refusing to start HTTP on ${host}: Clustr has no app-level authentication ` +
      "yet, so this would expose unauthenticated control of your cluster. Bind " +
      "127.0.0.1 (the default) and put an authenticating reverse proxy / tunnel " +
      "(e.g. Cloudflare Tunnel + Access) in front, or set " +
      "CLUSTR_ALLOW_UNAUTHENTICATED=true to acknowledge that something else " +
      "authenticates callers.",
  );
}

export interface HttpOptions {
  host: string;
  port: number;
  allowUnauthenticated: boolean;
  allowedHosts: string[];
}

export async function runHttp(
  buildServer: () => McpServer,
  opts: HttpOptions,
): Promise<void> {
  assertSafeBind(opts.host, opts.allowUnauthenticated);

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "clustr" });
  });

  // One transport per session, kept by session id.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (req: Request, res: Response) => {
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
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        allowedHosts: opts.allowedHosts.length ? opts.allowedHosts : undefined,
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
  });

  // GET = SSE stream, DELETE = end session.
  const bySession = async (req: Request, res: Response): Promise<void> => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing session id");
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get("/mcp", bySession);
  app.delete("/mcp", bySession);

  await new Promise<void>((resolve) => {
    app.listen(opts.port, opts.host, () => {
      // stderr so it never corrupts a stdio peer if misconfigured.
      console.error(`Clustr HTTP transport listening on ${opts.host}:${opts.port}/mcp`);
      if (!LOOPBACK.has(opts.host)) {
        console.error(
          "WARNING: bound to a non-loopback address with no app-level auth — " +
            "ensure an authenticating proxy/tunnel is in front.",
        );
      }
      resolve();
    });
  });
}
