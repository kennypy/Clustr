/**
 * run_container_command: run a shell command inside an LXC container.
 *
 * Proxmox exposes no REST `exec` for containers, so this drives the container
 * **console**: it opens a `termproxy` session, connects the `vncwebsocket`,
 * types a marker-wrapped command into the shell, and scrapes the output back
 * out of the terminal stream. That makes it inherently best-effort (it depends
 * on a normal `/bin/sh` prompt and clean PTY output), but it's the only way to
 * run a command in an LXC over an API token alone, with no SSH to the host.
 *
 * Requires the container to be running and the token to hold VM.Console. Gated
 * behind confirm=true like other write tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ProxmoxError, openProxmoxWebsocket, proxmoxPost } from "../../proxmox.js";
import { needsConfirm, safe } from "../../safe.js";
import {
  formatExecResult,
  makeMarkers,
  parseConsoleOutput,
  wrapForConsole,
  type ExecOutcome,
} from "../../exec.js";

const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;

interface ExecArgs {
  node: string;
  ctid: number;
  command: string;
  timeout_seconds: number;
}

/** Frame a chunk of input the way the Proxmox xterm.js console expects:
 *  `0:<utf8-byte-length>:<data>`. */
function frameInput(data: string): string {
  return `0:${Buffer.byteLength(data, "utf8")}:${data}`;
}

function decode(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data as ArrayBufferView);
  }
  return String(data ?? "");
}

async function consoleExec(a: ExecArgs): Promise<string> {
  // 1. Open a console session. Needs VM.Console on the container.
  const term = (await proxmoxPost(`/nodes/${a.node}/lxc/${a.ctid}/termproxy`)) as {
    ticket?: string;
    port?: number | string;
    user?: string;
  };
  if (!term?.ticket || term.port === undefined) {
    throw new ProxmoxError(
      `Could not open a console for container ${a.ctid} on ${a.node}. Make sure the ` +
        "container is running and the API token has the VM.Console privilege.",
    );
  }

  const markers = makeMarkers();
  const ws = openProxmoxWebsocket(
    `/nodes/${a.node}/lxc/${a.ctid}/vncwebsocket`,
    { port: term.port, vncticket: term.ticket },
  );
  ws.binaryType = "arraybuffer";

  return await new Promise<string>((resolve, reject) => {
    let raw = "";
    let authed = false;
    let settled = false;
    let keepalive: ReturnType<typeof setInterval> | undefined;

    const cleanup = (): void => {
      if (keepalive) clearInterval(keepalive);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };

    const finish = (outcome: ExecOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(
        formatExecResult(`container ${a.ctid} on ${a.node}`, a.command, outcome),
      );
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    };

    const timer = setTimeout(() => {
      const parsed = parseConsoleOutput(raw, markers);
      if (parsed.complete) {
        finish({ exitCode: parsed.exitCode, combined: parsed.output });
      } else {
        finish({ exitCode: null, combined: parsed.output, timedOut: true });
      }
    }, a.timeout_seconds * 1000);

    ws.addEventListener("open", () => {
      // Authenticate the terminal session, then keep it alive with pings.
      ws.send(`${term.user ?? "root@pam"}:${term.ticket}\n`);
      keepalive = setInterval(() => {
        try {
          ws.send("2");
        } catch {
          /* socket gone */
        }
      }, 15000);
    });

    ws.addEventListener("message", (event: { data: unknown }) => {
      raw += decode(event.data);

      if (!authed) {
        // The server answers the auth handshake with "OK"; once seen, widen the
        // terminal (so long lines don't wrap mid-output) and type the command.
        if (!raw.includes("OK")) return;
        authed = true;
        raw = ""; // drop the handshake noise before the command's output
        ws.send("1:240:50:"); // resize wide so long output lines don't wrap
        ws.send(frameInput(wrapForConsole(a.command, markers)));
        return;
      }

      const parsed = parseConsoleOutput(raw, markers);
      if (parsed.complete) {
        finish({ exitCode: parsed.exitCode, combined: parsed.output });
      }
    });

    ws.addEventListener("error", () => {
      fail(
        new ProxmoxError(
          `Console connection failed for container ${a.ctid} on ${a.node}. The ` +
            "container must be running and the token needs VM.Console.",
        ),
      );
    });

    ws.addEventListener("close", () => {
      if (settled) return;
      const parsed = parseConsoleOutput(raw, markers);
      if (parsed.complete) {
        finish({ exitCode: parsed.exitCode, combined: parsed.output });
      } else {
        fail(
          new ProxmoxError(
            `Console for container ${a.ctid} closed before the command finished. ` +
              "Confirm the container is running and has a /bin/sh shell.",
          ),
        );
      }
    });
  });
}

export function register(server: McpServer): void {
  server.registerTool(
    "run_container_command",
    {
      title: "Run Command in LXC Container (Console)",
      description:
        "Run a shell command inside a running LXC container and capture its output. " +
        "Proxmox has no exec API for containers, so this drives the container console " +
        "and scrapes the result (it's best-effort, expects a normal /bin/sh prompt) " +
        "and can't split stdout from stderr. The command runs through the shell, so " +
        "`&&`, pipes, and redirection work (e.g. `apt-get update && apt-get -y " +
        "upgrade`); run things non-interactively (pass `-y`). The container must be " +
        "running and the API token needs VM.Console. For QEMU VMs use " +
        "`run_vm_command`. confirm=false (default) previews; confirm=true runs.",
      inputSchema: {
        node: z.string().describe("Node name where the container resides (e.g. 'pve')"),
        ctid: z.number().int().min(100).describe("Container ID"),
        command: z
          .string()
          .min(1)
          .describe("Shell command to run, e.g. 'apt-get update && apt-get -y upgrade'"),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(600)
          .default(60)
          .describe("How long to wait for the command to finish (default 60s)."),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Must be true to actually run the command. When false (default), " +
              "returns a preview without executing.",
          ),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ node, ctid, command, timeout_seconds, confirm }) =>
      safe("run_container_command", async () => {
        if (!confirm) {
          return (
            `${needsConfirm("run a shell command on", `container ${ctid} on ${node}`)}\n\n` +
            `**Command to run:** \`${command}\``
          );
        }
        return consoleExec({ node, ctid, command, timeout_seconds });
      }),
  );
}
