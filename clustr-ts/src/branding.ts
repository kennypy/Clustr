/**
 * Clustr brand mark, kept in one place and reused by:
 *  - the MCP `serverInfo.icons` advertised to connector clients (the icon Claude
 *    shows on the connector card), as a self-contained `data:` URI so it works in
 *    both stdio and HTTP mode without needing the public URL;
 *  - the `/favicon.svg` route and the OAuth sign-in page (HTTP mode only).
 *
 * The same artwork lives at `assets/logo.svg` (source) and is rasterised to
 * `icon.png` for the Desktop-extension manifest at pack time.
 */

export const LOGO_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">` +
  `<defs>` +
  `<linearGradient id="g2" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0" stop-color="#0f172a"/><stop offset="1" stop-color="#1e293b"/>` +
  `</linearGradient>` +
  `<linearGradient id="cyan" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#0ea5e9"/>` +
  `</linearGradient>` +
  `</defs>` +
  `<rect x="0" y="0" width="512" height="512" rx="112" ry="112" fill="url(#g2)"/>` +
  `<path d="M 340.961 147.255 A 138.000 138.000 0 1 0 340.961 364.745" fill="none" stroke="url(#cyan)" stroke-width="56.000" stroke-linecap="round"/>` +
  `<circle cx="340.96" cy="147.25" r="34.00" fill="#0f172a"/>` +
  `<circle cx="340.96" cy="147.25" r="22.00" fill="url(#cyan)"/>` +
  `<circle cx="340.96" cy="364.75" r="34.00" fill="#0f172a"/>` +
  `<circle cx="340.96" cy="364.75" r="22.00" fill="url(#cyan)"/>` +
  `<circle cx="167.30" cy="150.29" r="14.00" fill="#67e8f9"/>` +
  `<circle cx="167.30" cy="361.71" r="14.00" fill="#67e8f9"/>` +
  `</svg>`;

/** The same mark as a base64 `data:` URI, for `serverInfo.icons[].src`. */
export const LOGO_DATA_URI =
  "data:image/svg+xml;base64," + Buffer.from(LOGO_SVG, "utf8").toString("base64");
