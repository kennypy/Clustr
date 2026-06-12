// Unit tests for the endpoint registry. Build first: `npm run build`.
import assert from "node:assert/strict";
import test from "node:test";

import {
  resetEndpoints,
  endpoints,
  defaultEndpointName,
  hasEndpoint,
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
