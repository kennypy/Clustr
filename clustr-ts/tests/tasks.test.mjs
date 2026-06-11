// Unit tests for UPID node parsing. Build first: `npm run build`.
import assert from "node:assert/strict";
import test from "node:test";

import { nodeFromUpid } from "../dist/tools/read/tasks.js";

test("parses the node out of a UPID", () => {
  const upid = "UPID:pve:0001ABCD:00ABCDEF:65000000:qmcreate:200:root@pam:";
  assert.equal(nodeFromUpid(upid), "pve");
  assert.equal(nodeFromUpid("UPID:pve2:x:y:z:vzdump:100:root@pam:"), "pve2");
});

test("rejects a non-UPID string", () => {
  assert.throws(() => nodeFromUpid("not-a-upid"), /valid task UPID/);
  assert.throws(() => nodeFromUpid("UPID:"), /valid task UPID/);
});
