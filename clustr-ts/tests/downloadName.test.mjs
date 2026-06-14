// Pass-3 hardening: download filename sanitizer (pure). Build first.
import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeDownloadName } from "../dist/tools/write/downloads.js";

test("download name: strips directory + traversal", () => {
  assert.equal(sanitizeDownloadName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeDownloadName("/abs/path/file.iso"), "file.iso");
  assert.equal(sanitizeDownloadName("a\\b\\c.img"), "c.img");
  assert.equal(sanitizeDownloadName(".."), "download"); // nothing usable left
  assert.equal(sanitizeDownloadName(""), "download");
});

test("download name: keeps normal names, neutralises odd chars", () => {
  assert.equal(sanitizeDownloadName("debian-12.iso"), "debian-12.iso");
  assert.equal(sanitizeDownloadName("debian 12.iso"), "debian_12.iso");
});
