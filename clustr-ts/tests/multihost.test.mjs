// Unit tests for central path-identifier validation. Build first: `npm run build`.
import assert from "node:assert/strict";
import test from "node:test";

import { invalidPathIdentifier } from "../dist/multihost.js";

test("accepts valid node / poolid / storage identifiers", () => {
  assert.equal(invalidPathIdentifier({ node: "pve" }), null);
  assert.equal(invalidPathIdentifier({ node: "pve-2.lab_1" }), null);
  assert.equal(invalidPathIdentifier({ poolid: "Prod-Pool_1" }), null);
  assert.equal(invalidPathIdentifier({ vmid: 100, node: "node1" }), null);
  assert.equal(invalidPathIdentifier({ storage: "local-lvm" }), null);
  assert.equal(invalidPathIdentifier({ storage: "cephfs.pool_1" }), null);
  assert.equal(invalidPathIdentifier({}), null); // nothing to validate
  assert.equal(invalidPathIdentifier({ node: undefined }), null);
});

test("rejects path-injection in node / poolid / storage (L2)", () => {
  assert.match(invalidPathIdentifier({ node: "pve/qemu/100/config" }) ?? "", /Invalid `node`/);
  assert.match(invalidPathIdentifier({ node: "pve qemu" }) ?? "", /Invalid `node`/);
  assert.match(invalidPathIdentifier({ node: "../../etc" }) ?? "", /Invalid `node`/);
  assert.match(invalidPathIdentifier({ poolid: "a/b" }) ?? "", /Invalid `poolid`/);
  // storage is interpolated as /storage/${storage}/... — a `/` would smuggle
  // extra path segments (e.g. escape to another node subresource).
  assert.match(invalidPathIdentifier({ storage: "local/../qemu" }) ?? "", /Invalid `storage`/);
  assert.match(invalidPathIdentifier({ storage: "a/b/content" }) ?? "", /Invalid `storage`/);
});

test("only inspects string identifier fields, ignores other args", () => {
  // A non-identifier free-text field is not constrained here.
  assert.equal(invalidPathIdentifier({ command: "apt-get update && reboot" }), null);
  assert.equal(invalidPathIdentifier({ node: 5 }), null); // non-string: skip
});
