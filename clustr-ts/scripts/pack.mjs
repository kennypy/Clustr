// Build + pack a uniquely-versioned .mcpb so Claude Desktop always installs it
// as a *new* version (no uninstall/reinstall dance). The bumped version is
// written only into the packed bundle; the tracked manifest.json is restored,
// so git stays clean and there are no pull conflicts.
//
//   npm run pack            -> auto monotonic version (0.1.<minutes-since-epoch>)
//   npm run pack -- 0.3.0   -> explicit version (for a real release)
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const MANIFEST = "manifest.json";
const original = readFileSync(MANIFEST, "utf8");
const manifest = JSON.parse(original);

const base = String(manifest.version || "0.1.0").split(".").slice(0, 2).join(".");
const version = process.argv[2] || `${base}.${Math.floor(Date.now() / 60000)}`;

try {
  console.log("Building…");
  execSync("npm run build", { stdio: "inherit" });

  manifest.version = version;
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`Packing clustr.mcpb as version ${version}…`);
  execSync("npx --yes @anthropic-ai/mcpb pack . clustr.mcpb", { stdio: "inherit" });

  console.log(
    `\n✅ clustr.mcpb built as ${version}: import it in Claude Desktop ` +
      "(it installs as a new version, so updates just work).",
  );
} finally {
  // Always restore the committed manifest version, even if pack failed.
  writeFileSync(MANIFEST, original);
}
