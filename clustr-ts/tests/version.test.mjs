// Unit tests for the pure Proxmox version helpers. Build first: `npm run build`.
import assert from "node:assert/strict";
import test from "node:test";

import { parseVersion, atLeast } from "../dist/version.js";

test("parseVersion reads major/minor from the /version payload", () => {
  assert.deepEqual(parseVersion({ version: "8.2.2" }), {
    version: "8.2.2",
    major: 8,
    minor: 2,
  });
  assert.deepEqual(parseVersion({ version: "8.1.4", release: "8.1" }), {
    version: "8.1.4",
    major: 8,
    minor: 1,
  });
  // Two-component versions parse too.
  assert.deepEqual(parseVersion({ version: "9.0" }), {
    version: "9.0",
    major: 9,
    minor: 0,
  });
});

test("parseVersion returns null on unexpected shapes", () => {
  assert.equal(parseVersion(null), null);
  assert.equal(parseVersion({}), null);
  assert.equal(parseVersion({ version: 8 }), null);
  assert.equal(parseVersion({ version: "not-a-version" }), null);
});

test("atLeast compares major then minor, and fails safe on unknown", () => {
  const v82 = { version: "8.2.2", major: 8, minor: 2 };
  const v81 = { version: "8.1.4", major: 8, minor: 1 };
  const v90 = { version: "9.0.1", major: 9, minor: 0 };

  assert.equal(atLeast(v82, 8, 2), true); // exact
  assert.equal(atLeast(v81, 8, 2), false); // older minor
  assert.equal(atLeast(v90, 8, 2), true); // newer major
  assert.equal(atLeast(v82, 9, 0), false); // older major
  // Unknown version is treated as "not at least" so callers stay conservative.
  assert.equal(atLeast(null, 8, 2), false);
});
