// Unit tests for the command-execution helpers. Build first: `npm run build`.
import assert from "node:assert/strict";
import test from "node:test";

import {
  shellArgv,
  stripAnsi,
  wrapForConsole,
  parseConsoleOutput,
  clampOutput,
  formatExecResult,
} from "../dist/exec.js";

const M = { begin: "__CLUSTR_B_abc__", end: "__CLUSTR_E_abc__" };

test("shellArgv wraps the command in /bin/sh -c", () => {
  assert.deepEqual(shellArgv("apt-get update && apt-get -y upgrade"), [
    "/bin/sh",
    "-c",
    "apt-get update && apt-get -y upgrade",
  ]);
});

test("stripAnsi removes color codes, CR, and cursor moves", () => {
  const raw = "\x1b[0;32mok\x1b[0m\r\nline2\x1b[2K\x1b[1G";
  assert.equal(stripAnsi(raw), "ok\nline2");
});

test("wrapForConsole frames the command with markers and exit code", () => {
  assert.equal(
    wrapForConsole("mkdir -p /tmp/x", M),
    "echo __CLUSTR_B_abc__; mkdir -p /tmp/x; echo __CLUSTR_E_abc__:$?\n",
  );
});

test("parseConsoleOutput extracts output and exit code, ignoring the echoed input", () => {
  // The echoed command line itself mentions both markers (with literal `$?`);
  // only the real end marker carries a numeric exit code.
  const transcript =
    "root@ct:~# echo __CLUSTR_B_abc__; mkdir -p /tmp/x && echo done; echo __CLUSTR_E_abc__:$?\r\n" +
    "__CLUSTR_B_abc__\r\n" +
    "done\r\n" +
    "__CLUSTR_E_abc__:0\r\n" +
    "root@ct:~# ";
  const r = parseConsoleOutput(transcript, M);
  assert.equal(r.complete, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.output, "done");
});

test("parseConsoleOutput captures non-zero exit codes", () => {
  const transcript =
    "echo __CLUSTR_B_abc__; false; echo __CLUSTR_E_abc__:$?\r\n" +
    "__CLUSTR_B_abc__\r\n" +
    "__CLUSTR_E_abc__:1\r\n";
  const r = parseConsoleOutput(transcript, M);
  assert.equal(r.complete, true);
  assert.equal(r.exitCode, 1);
  assert.equal(r.output, "");
});

test("parseConsoleOutput reports incomplete when the end marker is absent", () => {
  const r = parseConsoleOutput("__CLUSTR_B_abc__\r\npartial output", M);
  assert.equal(r.complete, false);
  assert.equal(r.exitCode, null);
});

test("parseConsoleOutput tolerates ANSI noise around the markers", () => {
  const transcript =
    "\x1b[0;32m__CLUSTR_B_abc__\x1b[0m\r\n" +
    "\x1b[1mhello\x1b[0m\r\n" +
    "__CLUSTR_E_abc__:0\r\n";
  const r = parseConsoleOutput(transcript, M);
  assert.equal(r.exitCode, 0);
  assert.equal(r.output, "hello");
});

test("clampOutput keeps short output and truncates long output", () => {
  assert.equal(clampOutput("short", 100), "short");
  const big = "x".repeat(50000);
  const clamped = clampOutput(big, 1000);
  assert.ok(clamped.length < big.length);
  assert.match(clamped, /characters truncated/);
});

test("formatExecResult marks success, failure, and timeout distinctly", () => {
  const ok = formatExecResult("VM 100 on pve", "ls", {
    exitCode: 0,
    combined: "file1\nfile2",
  });
  assert.match(ok, /Command succeeded/);
  assert.match(ok, /file1/);

  const bad = formatExecResult("VM 100 on pve", "false", {
    exitCode: 1,
    stderr: "boom",
  });
  assert.match(bad, /Command failed.*exit code 1/s);
  assert.match(bad, /boom/);

  const slow = formatExecResult("container 130 on pve", "sleep 999", {
    exitCode: null,
    timedOut: true,
  });
  assert.match(slow, /timed out/);
});
