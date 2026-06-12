// Unit tests for the two-step container restore token logic (pure, no Proxmox).
// Build first: `npm run build`.
import assert from "node:assert/strict";
import test from "node:test";

import {
  pendingRestores,
  consumeRestoreToken,
} from "../dist/tools/write/containerRestore.js";

function seed(ctid = 200) {
  pendingRestores.clear();
  pendingRestores.set("tok", {
    node: "pve",
    archive: "local:backup/vzdump-lxc-100-x.tar.zst",
    ctid,
    storage: "",
    force: false,
    overwrite: false,
    expires: Date.now() + 300_000,
  });
}

test("ct restore: wrong target ctid is rejected", () => {
  seed(200);
  assert.throws(() => consumeRestoreToken("tok", 999), /mismatch/);
  assert.equal(pendingRestores.has("tok"), true); // not consumed on failure
  pendingRestores.clear();
});

test("ct restore: token is single-use", () => {
  seed(200);
  const r = consumeRestoreToken("tok", 200);
  assert.equal(r.ctid, 200);
  assert.equal(pendingRestores.has("tok"), false);
  pendingRestores.clear();
});

test("ct restore: expired token is purged and rejected", () => {
  pendingRestores.clear();
  pendingRestores.set("tok", {
    node: "pve",
    archive: "local:backup/vzdump-lxc-100-x.tar.zst",
    ctid: 200,
    storage: "",
    force: false,
    overwrite: false,
    expires: Date.now() - 1,
  });
  assert.throws(() => consumeRestoreToken("tok", 200), /not found or expired/);
  pendingRestores.clear();
});

test("ct restore: unknown token is rejected", () => {
  pendingRestores.clear();
  assert.throws(() => consumeRestoreToken("nope", 200), /not found or expired/);
});
