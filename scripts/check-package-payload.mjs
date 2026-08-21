import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (Object.hasOwn(manifest, "pi"))
  throw new Error("runtime package must not declare a pi manifest");

const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
  env: { ...process.env, npm_config_loglevel: "silent" },
});
const [packed] = JSON.parse(output);
const paths = packed.files.map((file) => file.path).sort();
const allowedTopLevel = new Set([
  "dist",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
]);
for (const path of paths) {
  const topLevel = path.split("/")[0];
  if (!allowedTopLevel.has(topLevel)) throw new Error(`unexpected packed path: ${path}`);
  if (/(^|\/)(extensions|skills|prompts|themes)(\/|$)/.test(path)) {
    throw new Error(`Pi resource leaked into runtime package: ${path}`);
  }
}
for (const exportTarget of Object.values(manifest.exports)) {
  const target = typeof exportTarget === "string" ? exportTarget : exportTarget.import;
  const path = target.replace(/^\.\//, "");
  if (!paths.includes(path)) throw new Error(`packed export is missing: ${path}`);
}
console.log(`package payload verified: ${paths.length} files`);
