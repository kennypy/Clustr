// Unit tests for the onboarding helpers. Build first: `npm run build`.
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseHostInput,
  proxmoxWebUrl,
  buildProvisionScript,
  privsForCli,
  privsForApi,
  formatGuide,
  tokenId,
  CLUSTR_PRIVS,
} from "../dist/setup.js";

test("parseHostInput accepts bare IP, host:port, and full URL", () => {
  assert.deepEqual(parseHostInput("192.168.1.10"), { host: "192.168.1.10", port: 8006 });
  assert.deepEqual(parseHostInput("192.168.1.10:8007"), { host: "192.168.1.10", port: 8007 });
  assert.deepEqual(parseHostInput("https://pve.local:8006/"), { host: "pve.local", port: 8006 });
  assert.deepEqual(parseHostInput("  https://10.0.0.5:8006/#v1  "), { host: "10.0.0.5", port: 8006 });
});

test("parseHostInput handles bracketed IPv6 and rejects empty", () => {
  assert.deepEqual(parseHostInput("[2001:db8::1]:8006"), { host: "2001:db8::1", port: 8006 });
  assert.throws(() => parseHostInput("   "), /required/);
});

test("proxmoxWebUrl builds the web UI URL", () => {
  assert.equal(proxmoxWebUrl("192.168.1.10", 8006), "https://192.168.1.10:8006/");
  assert.equal(proxmoxWebUrl("pve", 8007), "https://pve:8007/");
});

test("privilege lists are non-empty and include exec privileges", () => {
  assert.ok(CLUSTR_PRIVS.length > 10);
  // VM.Monitor (guest-agent exec) and VM.Console (LXC console exec) must be present.
  assert.ok(CLUSTR_PRIVS.includes("VM.Monitor"));
  assert.ok(CLUSTR_PRIVS.includes("VM.Console"));
  assert.equal(privsForCli(), CLUSTR_PRIVS.join(" "));
  assert.equal(privsForApi(), CLUSTR_PRIVS.join(","));
});

test("buildProvisionScript (full) creates a role, user, token, and ACL", () => {
  const s = buildProvisionScript({ mode: "full", user: "clustr@pve", tokenName: "clustr" });
  assert.match(s, /pveum role add Clustr/);
  assert.match(s, /pveum user token add clustr@pve clustr --privsep 0/);
  assert.match(s, /pveum acl modify \/ --users clustr@pve --roles Clustr/);
});

test("buildProvisionScript (readonly) skips the custom role and uses PVEAuditor", () => {
  const s = buildProvisionScript({ mode: "readonly", user: "clustr@pve", tokenName: "ro" });
  assert.doesNotMatch(s, /role add Clustr/);
  assert.match(s, /--roles PVEAuditor/);
  assert.match(s, /pveum user token add clustr@pve ro/);
});

test("formatGuide includes the login URL, the snippet, and the paste-back values", () => {
  const g = formatGuide({ host: "192.168.1.10", port: 8006, mode: "full", user: "clustr@pve", tokenName: "clustr" });
  assert.match(g, /https:\/\/192\.168\.1\.10:8006\//);
  assert.match(g, /pveum user token add/);
  assert.match(g, /Token name:\*\* `clustr`/);
  assert.match(g, /admin_user/); // mentions the automated alternative
});

test("tokenId joins user and token name", () => {
  assert.equal(tokenId("clustr@pve", "clustr"), "clustr@pve!clustr");
});
