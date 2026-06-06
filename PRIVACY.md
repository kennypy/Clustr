# Privacy Policy — Clustr

_Last updated: 2025_

Clustr is a self-hosted Model Context Protocol (MCP) server that lets an MCP
client (such as Claude) manage **your own** Proxmox VE cluster. Each operator
runs their own instance; there is no central Clustr service.

## What Clustr does with data

- **Proxmox credentials** (`PROXMOX_*`) are read from the operator's environment
  / `.env` and used solely to authenticate to the operator's own Proxmox API.
  They are never transmitted anywhere except to that Proxmox host.
- **Tool requests and responses** (node/VM/container data, commands) flow
  between the MCP client and your Proxmox cluster. Clustr does not persist them;
  it holds only short-lived, in-memory deletion-confirmation tokens (5-minute
  TTL) needed for the two-step delete flow.
- **Logs** may contain operational metadata (tool name, node, error messages).
  These are written to the operator's own logging destination and are under the
  operator's control. Clustr does not ship logs or telemetry to any third party.

## What Clustr does NOT do

- No analytics, tracking, advertising, or telemetry.
- No selling or sharing of data.
- No storage of Proxmox data beyond the in-memory delete tokens described above.

## Authentication data

When OAuth is enabled, bearer tokens are validated against the operator's
configured authorization server and are not stored by Clustr.

## Your responsibilities as the operator

Because you self-host Clustr, you are the data controller. Secure the endpoint
(TLS, OAuth, network controls), protect your `.env`, and follow your own
organization's data-handling requirements.

## Contact

Operator-defined. Replace this with your contact address before publishing:
`security@your-domain.example`.
