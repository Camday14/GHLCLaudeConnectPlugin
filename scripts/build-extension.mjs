#!/usr/bin/env node
/**
 * Builds the one-click Claude Desktop Extension: release/GoHighLevel.mcpb
 *  1. Bundle the local stdio server into a single file (no node_modules needed).
 *  2. Generate manifest.json (version from package.json, tool list from the code).
 *  3. Validate and pack with @anthropic-ai/mcpb.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build", "extension");
const releaseDir = join(root, "release");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "server"), { recursive: true });
await mkdir(releaseDir, { recursive: true });

const esmShim = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);";

// 1. Server bundle
await build({
  entryPoints: [join(root, "src/local/index.ts")],
  outfile: join(out, "server/index.mjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: { js: esmShim },
  legalComments: "none",
  logLevel: "warning",
});

// 2. Tool list (bundle the tool registry to a temp module and import it)
const toolsModule = join(root, "build", "tools-list.mjs");
await build({
  stdin: { contents: `export { ALL_TOOLS } from "./src/core/server.ts";`, resolveDir: root, loader: "ts" },
  outfile: toolsModule,
  bundle: true,
  platform: "node",
  format: "esm",
  banner: { js: esmShim },
  logLevel: "warning",
});
const { ALL_TOOLS } = await import(pathToFileURL(toolsModule).href);
const tools = ALL_TOOLS.map((t) => ({ name: t.name, description: t.description.split(". ")[0].replace(/\.$/, "") + "." }));

const template = JSON.parse(await readFile(join(root, "extension/manifest.template.json"), "utf8"));
const manifest = { ...template, version: pkg.version, tools };
await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
await copyFile(join(root, "extension/icon.png"), join(out, "icon.png"));
await copyFile(join(root, "README.md"), join(out, "README.md"));
await writeFile(join(out, "package.json"), JSON.stringify({ name: "gohighlevel-extension", version: pkg.version, type: "module", private: true }, null, 2));

// 3. Validate + pack
const mcpb = join(root, "node_modules/@anthropic-ai/mcpb/dist/cli/cli.js");
execFileSync(process.execPath, [mcpb, "validate", join(out, "manifest.json")], { stdio: "inherit" });
const target = join(releaseDir, "GoHighLevel.mcpb");
await rm(target, { force: true });
execFileSync(process.execPath, [mcpb, "pack", out, target], { stdio: "inherit" });
console.log(`\nBuilt ${target} (${tools.length} tools, v${pkg.version})`);
