// Unit tests for the pre-delete backup hint (pure formatter, no Proxmox).
// Build first: `npm run build`.
import assert from "node:assert/strict";
import test from "node:test";

import { formatBackupHint } from "../dist/backupHints.js";

test("hint: empty when no backup-capable storage", () => {
  assert.equal(formatBackupHint([], "vm"), "");
  // present but inactive/disabled => not offered
  assert.equal(
    formatBackupHint([{ storage: "local", active: 0 }], "container"),
    "",
  );
});

test("hint: calls out PBS and the right guest-type tools", () => {
  const rows = [
    { storage: "local", type: "dir", active: 1 },
    { storage: "pbs", type: "pbs", active: 1 },
  ];
  const vm = formatBackupHint(rows, "vm");
  assert.match(vm, /Proxmox Backup Server/);
  assert.match(vm, /`pbs`/); // PBS named
  assert.match(vm, /create_vm_backup/);
  assert.match(vm, /clone_vm/);
  assert.match(vm, /create_vm_backup` → `pbs`/); // PBS is the suggested target

  const ct = formatBackupHint(rows, "container");
  assert.match(ct, /create_container_backup/);
  assert.match(ct, /clone_container/);
});

test("hint: no PBS falls back to first backup storage, no PBS note", () => {
  const rows = [{ storage: "local", type: "dir", active: 1 }];
  const out = formatBackupHint(rows, "vm");
  assert.doesNotMatch(out, /Proxmox Backup Server/);
  assert.match(out, /create_vm_backup` → `local`/);
});
