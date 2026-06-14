// Endpoint validation: a crafted host must not be able to redirect the Proxmox
// request (token exfiltration / SSRF) or inject headers. Build first.
import assert from "node:assert/strict";
import test from "node:test";

import { normalize } from "../dist/endpoints.js";

const base = { name: "x", tokenName: "t", tokenValue: "v" };

test("endpoint host: rejects URL-confusion hosts", () => {
  for (const host of [
    "attacker.com/", // trailing slash → path, host stays attacker.com
    "a@evil.com", // userinfo → real host is evil.com
    "evil.com:9999", // embedded port
    "http://evil.com", // scheme
    "evil.com/api2/json", // path
    "evil.com#x",
    "evil.com?x=1",
    "1.2.3.4 5.6.7.8", // embedded space
  ]) {
    assert.throws(() => normalize({ ...base, host }), /Invalid endpoint host/, host);
  }
});

test("endpoint host: accepts bare hostnames / IPv4 / [IPv6]", () => {
  for (const host of ["pve", "pve.lan", "192.168.1.10", "10.0.0.5", "[2001:db8::1]"]) {
    assert.doesNotThrow(() => normalize({ ...base, host }), host);
  }
});

test("endpoint fields: reject control chars (header injection)", () => {
  assert.throws(
    () => normalize({ ...base, host: "pve", tokenValue: "v\r\nX-Evil: 1" }),
    /control characters/,
  );
  assert.throws(
    () => normalize({ ...base, host: "pve", user: "root@pam\nInjected" }),
    /control characters/,
  );
});

test("endpoint port: must be a sane integer", () => {
  assert.throws(() => normalize({ ...base, host: "pve", port: 70000 }), /Invalid endpoint port/);
  assert.throws(() => normalize({ ...base, host: "pve", port: "8006abc" }), /Invalid endpoint port/);
  assert.doesNotThrow(() => normalize({ ...base, host: "pve", port: 8006 }));
});
