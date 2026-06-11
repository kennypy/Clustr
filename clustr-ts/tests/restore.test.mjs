// Unit tests for the two-step restore token logic (pure, no Proxmox).
// Build first: `npm run build`.
import assert from "node:assert/strict";
import test from "node:test";

import {
  pendingRestores,
  consumeRestoreToken,
} from "../dist/tools/write/vmRestore.js";

function seed(vmid = 200) {
  pendingRestores.clear();
  pendingRestores.set("tok", {
    node: "pve",
    archive: "local:backup/vzdump-qemu-100-x.vma.zst",
    vmid,
    storage: "",
    force: false,
    overwrite: false,
    expires: Date.now() + 300_000,
  });
}

test("restore: wrong target vmid is rejected", () => {
  seed(200);
  assert.throws(() => consumeRestoreToken("tok", 999), /mismatch/);
  assert.equal(pendingRestores.has("tok"), true); // not consumed on failure
  pendingRestores.clear();
});

test("restore: token is single-use", () => {
  seed(200);
  const r = consumeRestoreToken("tok", 200);
  assert.equal(r.vmid, 200);
  assert.equal(pendingRestores.has("tok"), false);
  pendingRestores.clear();
});

test("restore: expired token is purged and rejected", () => {
  pendingRestores.clear();
  pendingRestores.set("tok", {
    node: "pve",
    archive: "local:backup/vzdump-qemu-100-x.vma.zst",
    vmid: 200,
    storage: "",
    force: false,
    overwrite: false,
    expires: Date.now() - 1,
  });
  assert.throws(() => consumeRestoreToken("tok", 200), /not found or expired/);
  pendingRestores.clear();
});

test("restore: unknown token is rejected", () => {
  pendingRestores.clear();
  assert.throws(() => consumeRestoreToken("nope", 200), /not found or expired/);
});
