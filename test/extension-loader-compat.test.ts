import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const smokeScript = join(repoRoot, "scripts", "smoke-extension-loader.mjs");
const tempDirectories: string[] = [];

interface PackEntry {
  filename: string;
}

afterAll(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Pi 0.84.2 extension-loader compatibility", () => {
  it("loads packed Anthropic attribution through the real Jiti production boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-runtime-extension-loader-"));
    tempDirectories.push(root);
    const hostRoot = join(root, "host");
    const extensionRoot = join(root, "extension-package");
    await Promise.all([mkdir(hostRoot), mkdir(extensionRoot)]);

    const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", root], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_loglevel: "silent" },
    });
    const entries = JSON.parse(packOutput) as PackEntry[];
    const packed = entries[0];
    if (packed === undefined) throw new Error("npm pack returned no package entry");

    await Promise.all([
      writeFile(
        join(hostRoot, "package.json"),
        `${JSON.stringify(
          {
            private: true,
            type: "module",
            dependencies: {
              "@earendil-works/pi-ai": "0.84.2",
              "@earendil-works/pi-coding-agent": "0.84.2",
            },
          },
          null,
          2,
        )}\n`,
      ),
      writeFile(
        join(extensionRoot, "package.json"),
        `${JSON.stringify(
          {
            private: true,
            type: "module",
            dependencies: {
              "@sakiko233/pi-agent-runtime": `file:../${packed.filename}`,
            },
          },
          null,
          2,
        )}\n`,
      ),
    ]);
    const extensionPath = join(extensionRoot, "subagent-extension.ts");
    await writeFile(
      extensionPath,
      'import { anthropicAttributionExtension } from "@sakiko233/pi-agent-runtime/anthropic-attribution";\nexport default anthropicAttributionExtension;\n',
    );

    execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts"], {
      cwd: hostRoot,
      stdio: "pipe",
      env: { ...process.env, npm_config_loglevel: "error" },
    });
    execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--legacy-peer-deps"], {
      cwd: extensionRoot,
      stdio: "pipe",
      env: { ...process.env, npm_config_loglevel: "error" },
    });
    const output = execFileSync(
      process.execPath,
      [smokeScript, hostRoot, extensionRoot, extensionPath],
      {
        cwd: extensionRoot,
        encoding: "utf8",
      },
    );

    expect(output).toContain("Pi 0.84.2 loaded the Anthropic attribution extension");
  }, 120_000);
});
