// Unit tests for the two-step delete token logic (pure, no Proxmox).
// Build first: `npm run build`.
import assert from "node:assert/strict";
import test from "node:test";

import {
  pendingDeletes as vmPending,
  consumeDeleteToken as vmConsume,
} from "../dist/tools/write/vmDelete.js";
import {
  pendingDeletes as ctPending,
  consumeDeleteToken as ctConsume,
} from "../dist/tools/write/containerDelete.js";

test("vm delete: wrong name is rejected", () => {
  vmPending.clear();
  vmPending.set("tok", {
    node: "pve",
    vmid: 100,
    name: "my-vm",
    expires: Date.now() + 300_000,
  });
  assert.throws(() => vmConsume("tok", "wrong-name"), /mismatch/);
  assert.equal(vmPending.has("tok"), true); // not consumed on failure
  vmPending.clear();
});

test("vm delete: token is single-use (consumed on success)", () => {
  vmPending.clear();
  vmPending.set("tok", {
    node: "pve",
    vmid: 100,
    name: "my-vm",
    expires: Date.now() + 300_000,
  });
  const p = vmConsume("tok", "my-vm");
  assert.equal(p.vmid, 100);
  assert.equal(vmPending.has("tok"), false);
  vmPending.clear();
});

test("vm delete: expired token is purged and rejected", () => {
  vmPending.clear();
  vmPending.set("tok", {
    node: "pve",
    vmid: 100,
    name: "my-vm",
    expires: Date.now() - 1,
  });
  assert.throws(() => vmConsume("tok", "my-vm"), /not found or expired/);
  vmPending.clear();
});

test("vm delete: unknown token is rejected", () => {
  vmPending.clear();
  assert.throws(() => vmConsume("nope", "my-vm"), /not found or expired/);
});

test("container delete: wrong hostname is rejected", () => {
  ctPending.clear();
  ctPending.set("tok", {
    node: "pve",
    ctid: 103,
    hostname: "my-container",
    expires: Date.now() + 300_000,
  });
  assert.throws(() => ctConsume("tok", "wrong-host"), /mismatch/);
  ctPending.clear();
});

test("container delete: token is single-use", () => {
  ctPending.clear();
  ctPending.set("tok", {
    node: "pve",
    ctid: 103,
    hostname: "my-container",
    expires: Date.now() + 300_000,
  });
  const p = ctConsume("tok", "my-container");
  assert.equal(p.ctid, 103);
  assert.equal(ctPending.has("tok"), false);
  ctPending.clear();
});
