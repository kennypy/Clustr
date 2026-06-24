// Unit tests for the OAuth login throttle + the Proxmox path guard (pure).
// Build first: `npm run build`.
import assert from "node:assert/strict";
import test from "node:test";

import { makeLoginThrottle } from "../dist/oauth.js";
import { assertSafeApiPath } from "../dist/proxmox.js";

test("login throttle: blocks past the per-window cap", () => {
  const throttled = makeLoginThrottle(60_000, 3);
  assert.equal(throttled(), false); // 1
  assert.equal(throttled(), false); // 2
  assert.equal(throttled(), false); // 3
  assert.equal(throttled(), true); // 4, over cap
  assert.equal(throttled(), true); // stays blocked in-window
});

test("login throttle: resets after the window elapses", () => {
  let t = 1_000_000;
  const orig = Date.now;
  Date.now = () => t;
  try {
    const throttled = makeLoginThrottle(1000, 1);
    assert.equal(throttled(), false);
    assert.equal(throttled(), true); // over cap in window
    t += 1001; // window elapses
    assert.equal(throttled(), false); // fresh window
  } finally {
    Date.now = orig;
  }
});

test("path guard: allows normal Proxmox API paths", () => {
  assert.doesNotThrow(() => assertSafeApiPath("/nodes/pve/qemu/100/config"));
  assert.doesNotThrow(() => assertSafeApiPath("/nodes/pve-2/storage/local/content"));
});

test("path guard: rejects traversal segments", () => {
  assert.throws(() => assertSafeApiPath("/nodes/../../access/users"), /traversal/);
  assert.throws(() => assertSafeApiPath("/nodes/pve/..\\secret"), /traversal/);
});

test("path guard: rejects control characters", () => {
  assert.throws(() => assertSafeApiPath("/nodes/pve\n/qemu"), /control character/);
  assert.throws(() => assertSafeApiPath("/nodes/pve\x00x"), /control character/);
});
