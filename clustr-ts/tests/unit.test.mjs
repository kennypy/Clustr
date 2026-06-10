// Unit tests for the pure logic, run against the compiled output with the
// built-in node test runner (no extra deps). Build first: `npm run build`.
import assert from "node:assert/strict";
import test from "node:test";

import { parsePveManagerVersion } from "../dist/tools/read/updates.js";
import { agentEnabled } from "../dist/tools/read/vms.js";

const PACKAGES = [
  "Package: pve-kernel-6.8\nVersion: 6.8.4-2",
  "Package: pve-manager\nVersion: 8.2.4",
  "Package: qemu-server\nVersion: 8.2.1",
  "Package: pve-manager\nVersion: 8.2.7",
].join("\n\n");

test("parsePveManagerVersion picks pve-manager and the max version", () => {
  assert.equal(parsePveManagerVersion(PACKAGES), "8.2.7");
  assert.equal(parsePveManagerVersion("Package: qemu-server\nVersion: 9.9.9"), null);
});

test("agentEnabled reads the leading flag, not raw truthiness", () => {
  assert.equal(agentEnabled("1"), true);
  assert.equal(agentEnabled("enabled=1,fstrim_cloned_disks=1"), true);
  assert.equal(agentEnabled("0"), false);
  assert.equal(agentEnabled("enabled=0"), false);
  assert.equal(agentEnabled(""), false);
  assert.equal(agentEnabled(undefined), false);
});
