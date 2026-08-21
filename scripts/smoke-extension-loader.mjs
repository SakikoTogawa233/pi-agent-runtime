import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [hostRootArgument, extensionRootArgument, extensionPathArgument] = process.argv.slice(2);
const hostRoot = resolve(hostRootArgument);
const extensionRoot = resolve(extensionRootArgument);
const extensionPath = resolve(extensionPathArgument);
const codingAgentPackageRoot = join(hostRoot, "node_modules", "@earendil-works", "pi-coding-agent");
const codingAgentPackage = JSON.parse(
  await readFile(join(codingAgentPackageRoot, "package.json"), "utf8"),
);
if (codingAgentPackage.version !== "0.84.2") {
  throw new Error(`expected Pi 0.84.2, got ${String(codingAgentPackage.version)}`);
}

const loaderPath = join(codingAgentPackageRoot, "dist", "core", "extensions", "loader.js");
const { loadExtensions } = await import(pathToFileURL(loaderPath).href);
const result = await loadExtensions([extensionPath], extensionRoot);
if (result.errors.length !== 0) {
  throw new Error(result.errors.map(({ error }) => error).join("\n"));
}
if (result.extensions.length !== 1) {
  throw new Error(`expected one loaded extension, got ${String(result.extensions.length)}`);
}

console.log("Pi 0.84.2 loaded the Anthropic attribution extension through Jiti");
