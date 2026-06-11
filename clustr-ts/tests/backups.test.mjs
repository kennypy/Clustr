// Unit tests for VM-backup detection across file storages and PBS.
// Build first: `npm run build`.
import assert from "node:assert/strict";
import test from "node:test";

import { isVmBackup } from "../dist/tools/read/backups.js";

test("file-based vzdump VM backup is kept", () => {
  assert.equal(
    isVmBackup({ volid: "local:backup/vzdump-qemu-100-2026_06_11-00_00_00.vma.zst" }),
    true,
  );
});

test("file-based vzdump container backup is dropped", () => {
  assert.equal(
    isVmBackup({ volid: "local:backup/vzdump-lxc-141-2026_06_11-00_00_00.tar.zst" }),
    false,
  );
});

test("PBS VM backup is kept (regression: previously hidden)", () => {
  // No 'qemu' in the volid — the old filter dropped these.
  assert.equal(
    isVmBackup({ volid: "pbs:backup/vm/100/2026-06-11T00:00:00Z", subtype: "qemu" }),
    true,
  );
  assert.equal(isVmBackup({ volid: "pbs:backup/vm/100/2026-06-11T00:00:00Z" }), true);
});

test("PBS container backup is dropped", () => {
  assert.equal(
    isVmBackup({ volid: "pbs:backup/ct/141/2026-06-11T00:00:00Z", subtype: "lxc" }),
    false,
  );
});

test("explicit subtype wins over volid heuristic", () => {
  assert.equal(isVmBackup({ volid: "weird:backup/thing", subtype: "qemu" }), true);
  assert.equal(isVmBackup({ volid: "weird:backup/thing", subtype: "lxc" }), false);
});
