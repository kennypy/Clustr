// Unit tests for the endpoint registry. Build first: `npm run build`.
import assert from "node:assert/strict";
import test from "node:test";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

import {
  resetEndpoints,
  endpoints,
  defaultEndpointName,
  hasEndpoint,
  addEndpoint,
  removeEndpoint,
  canPersistEndpoints,
} from "../dist/endpoints.js";

function clearEnv() {
  for (const k of [
    "CLUSTR_ENDPOINTS",
    "CLUSTR_ENDPOINTS_FILE",
    "PROXMOX_HOST",
    "PROXMOX_TOKEN_NAME",
    "PROXMOX_TOKEN_VALUE",
  ])
    delete process.env[k];
}

test("single PROXMOX_* env -> one 'default' endpoint", () => {
  clearEnv();
  process.env.PROXMOX_HOST = "1.2.3.4";
  process.env.PROXMOX_TOKEN_NAME = "t";
  process.env.PROXMOX_TOKEN_VALUE = "s";
  resetEndpoints();
  const eps = endpoints();
  assert.equal(eps.length, 1);
  assert.equal(eps[0].name, "default");
  assert.equal(eps[0].host, "1.2.3.4");
  assert.equal(defaultEndpointName(), "default");
  clearEnv();
});

test("no config at all -> zero endpoints, no throw (desktop token-less boot)", () => {
  clearEnv();
  resetEndpoints();
  assert.equal(endpoints().length, 0);
  assert.equal(canPersistEndpoints(), false);
});

test("addEndpoint can register session-only when no endpoints file is set", () => {
  clearEnv();
  resetEndpoints();
  // persistToFile=false must NOT throw even with no CLUSTR_ENDPOINTS_FILE.
  const ep = addEndpoint(
    { name: "1.2.3.4", host: "1.2.3.4", tokenName: "clustr", tokenValue: "secret" },
    false,
  );
  assert.equal(ep.name, "1.2.3.4");
  assert.ok(hasEndpoint("1.2.3.4"));
  // The default (and only) endpoint resolves to it.
  assert.equal(defaultEndpointName(), "1.2.3.4");
  clearEnv();
  resetEndpoints();
});

test("addEndpoint(persist=true) without a file throws (explicit add_endpoint path)", () => {
  clearEnv();
  resetEndpoints();
  assert.throws(
    () => addEndpoint({ name: "x", host: "1.2.3.4", tokenName: "t", tokenValue: "s" }),
    /CLUSTR_ENDPOINTS_FILE/,
  );
  clearEnv();
  resetEndpoints();
});

test("removing the current default falls back to a live endpoint (no stale pointer)", () => {
  clearEnv();
  const file = join(tmpdir(), `clustr-eps-${process.pid}.json`);
  process.env.CLUSTR_ENDPOINTS_FILE = file;
  process.env.CLUSTR_ENDPOINTS = JSON.stringify([
    { name: "home", host: "h1", tokenName: "t", tokenValue: "s" },
    { name: "office", host: "h2", tokenName: "t", tokenValue: "s" },
  ]);
  resetEndpoints();
  assert.equal(defaultEndpointName(), "home");
  // Remove the endpoint the default currently points at. The cached defaultName
  // now references a deleted entry; defaultEndpointName() must re-resolve to a
  // remaining one rather than hand back a dangling name.
  assert.equal(removeEndpoint("home"), true);
  assert.equal(hasEndpoint("home"), false);
  assert.equal(defaultEndpointName(), "office");
  try {
    rmSync(file);
  } catch {
    /* best-effort cleanup */
  }
  clearEnv();
  resetEndpoints();
});

test("CLUSTR_ENDPOINTS json -> multiple, first is default", () => {
  clearEnv();
  process.env.CLUSTR_ENDPOINTS = JSON.stringify([
    { name: "home", host: "h1", tokenName: "t", tokenValue: "s" },
    { name: "office", host: "h2", tokenName: "t", tokenValue: "s" },
  ]);
  resetEndpoints();
  assert.equal(endpoints().length, 2);
  assert.ok(hasEndpoint("home") && hasEndpoint("office"));
  assert.equal(defaultEndpointName(), "home");
  clearEnv();
  resetEndpoints();
});
