/**
 * run_vm_command — run a shell command inside a QEMU VM via the guest agent.
 *
 * Uses POST /agent/exec (returns a PID) then polls /agent/exec-status until the
 * command exits, returning stdout/stderr/exit code. Requires the
 * `qemu-guest-agent` package installed and running in the guest, and the VM's
 * `agent` option enabled. Gated behind confirm=true like other write tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ProxmoxError, proxmoxGet, proxmoxPost } from "../../proxmox.js";
import { needsConfirm, safe } from "../../safe.js";
import { formatExecResult, shellArgv, type ExecOutcome } from "../../exec.js";

const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface ExecArgs {
  node: string;
  vmid: number;
  command: string;
  input_data?: string;
  timeout_seconds: number;
}

async function runCommand(a: ExecArgs): Promise<string> {
  let started: Record<string, any>;
  try {
    started = (await proxmoxPost(`/nodes/${a.node}/qemu/${a.vmid}/agent/exec`, {
      command: shellArgv(a.command),
      "input-data": a.input_data && a.input_data.length ? a.input_data : undefined,
    })) as Record<string, any>;
  } catch (err) {
    if (err instanceof ProxmoxError) {
      throw new ProxmoxError(
        `${err.message}\n\nThis usually means the QEMU guest agent isn't available ` +
          `on VM ${a.vmid}. Install \`qemu-guest-agent\` in the guest, enable the ` +
          "Agent option on the VM (Options → QEMU Guest Agent), and make sure the VM " +
          "is running. For LXC containers use `run_container_command` instead.",
        err.statusCode,
      );
    }
    throw err;
  }

  const pid = Number(started?.pid);
  if (!Number.isFinite(pid)) {
    throw new ProxmoxError(
      `Guest agent did not return a PID for the command on VM ${a.vmid}.`,
    );
  }

  const deadline = Date.now() + a.timeout_seconds * 1000;
  let status: Record<string, any> = {};
  let exited = false;
  while (Date.now() < deadline) {
    status = (await proxmoxGet(
      `/nodes/${a.node}/qemu/${a.vmid}/agent/exec-status`,
      { pid },
    )) as Record<string, any>;
    if (status.exited === 1 || status.exited === true) {
      exited = true;
      break;
    }
    await sleep(1000);
  }

  const outcome: ExecOutcome = exited
    ? {
        exitCode:
          status.exitcode === undefined || status.exitcode === null
            ? null
            : Number(status.exitcode),
        stdout: status["out-data"],
        stderr: status["err-data"],
        truncated: Boolean(status["out-truncated"] || status["err-truncated"]),
      }
    : { exitCode: null, timedOut: true };

  return formatExecResult(`VM ${a.vmid} on ${a.node}`, a.command, outcome);
}

export function register(server: McpServer): void {
  server.registerTool(
    "run_vm_command",
    {
      title: "Run Command in VM (Guest Agent)",
      description:
        "Run a shell command inside a running QEMU VM via the QEMU guest agent, " +
        "capturing stdout, stderr, and the exit code. The command runs through " +
        "`/bin/sh -c`, so pipes, `&&`, and redirection work (e.g. " +
        "`apt-get update && apt-get -y upgrade`). Commands run non-interactively — " +
        "pass `-y`/non-interactive flags yourself. Requires `qemu-guest-agent` " +
        "installed and running in the guest. For LXC containers use " +
        "`run_container_command`. confirm=false (default) previews; confirm=true runs.",
      inputSchema: {
        node: z.string().describe("Node name where the VM resides (e.g. 'pve')"),
        vmid: z.number().int().min(100).describe("VM ID"),
        command: z
          .string()
          .min(1)
          .describe("Shell command to run, e.g. 'apt-get update && apt-get -y upgrade'"),
        input_data: z
          .string()
          .optional()
          .describe("Optional data to pass to the command on stdin."),
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
    async ({ node, vmid, command, input_data, timeout_seconds, confirm }) =>
      safe("run_vm_command", async () => {
        if (!confirm) {
          return (
            `${needsConfirm("run a shell command on", `VM ${vmid} on ${node}`)}\n\n` +
            `**Command to run:** \`${command}\``
          );
        }
        return runCommand({ node, vmid, command, input_data, timeout_seconds });
      }),
  );
}
