import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const tempDirectories: string[] = [];

interface PackEntry {
  filename: string;
  files: Array<{ path: string }>;
}

afterAll(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function firstPackEntry(output: string): PackEntry {
  const entries = JSON.parse(output) as PackEntry[];
  const entry = entries[0];
  if (entry === undefined) throw new Error("npm pack returned no package entry");
  return entry;
}

function dryRunPack(): PackEntry {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: "silent" },
  });
  return firstPackEntry(output);
}

describe("packed runtime package", () => {
  it("contains declared runtime exports and no Pi resources or pi manifest", async () => {
    const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest.pi).toBeUndefined();
    expect(manifest.keywords).not.toContain("pi-package");

    const packed = dryRunPack();
    const paths = packed.files.map((file) => file.path).sort();
    expect(paths).toContain("dist/index.js");
    expect(paths).toContain("dist/anthropic-attribution.js");
    expect(paths).toContain("README.md");
    expect(paths).toContain("LICENSE");
    expect(paths).toContain("THIRD_PARTY_NOTICES.md");
    expect(paths.some((path) => /(^|\/)(extensions|skills|prompts|themes)(\/|$)/.test(path))).toBe(
      false,
    );
    expect(paths.some((path) => /(?:^|\/)SKILL\.md$/.test(path))).toBe(false);
    expect(paths.some((path) => /(?:^|\/)pi\.json$/.test(path))).toBe(false);
    expect(
      paths.every((path) =>
        /^(?:dist\/|README\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$|package\.json$)/.test(path),
      ),
    ).toBe(true);
  });

  it("resolves published exports from production installs for both future consumer package names", async () => {
    const runtimeVersion = (
      JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    const packOutput = execFileSync("npm", ["pack", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_loglevel: "silent" },
    });
    const tarballName = firstPackEntry(packOutput).filename;
    const tarball = join(repoRoot, tarballName);
    const root = await mkdtemp(join(tmpdir(), "pi-agent-runtime-consumers-"));
    tempDirectories.push(root);
    const consumerNames = ["pi-subagent", "pi-agent-fusion"];
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          type: "module",
          workspaces: consumerNames,
          dependencies: {
            "@sakiko233/pi-agent-runtime": `file:${tarball}`,
            "@earendil-works/pi-ai": "0.84.2",
            "@earendil-works/pi-coding-agent": "0.84.2",
          },
        },
        null,
        2,
      )}\n`,
    );
    for (const name of consumerNames) {
      const dir = join(root, name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "package.json"),
        `${JSON.stringify({ name: `@sakiko233/${name}`, version: "0.1.0", private: true, type: "module" }, null, 2)}\n`,
      );
      await writeFile(
        join(dir, "verify.mjs"),
        `import { canonicalJson } from '@sakiko233/pi-agent-runtime';\nimport { createAnthropicAttributionExtension } from '@sakiko233/pi-agent-runtime/anthropic-attribution';\nimport { spawnPiChild } from '@sakiko233/pi-agent-runtime/launch';\nimport { createRequire } from 'node:module';\nconst require=createRequire(import.meta.url);\nconst pkg=require('@sakiko233/pi-agent-runtime/package.json');\nif(pkg.version!=='${runtimeVersion}'||canonicalJson({b:2,a:1})!=='{"a":1,"b":2}'||typeof createAnthropicAttributionExtension!=='function'||typeof spawnPiChild!=='function') process.exit(1);\n`,
      );
    }
    execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts"], {
      cwd: root,
      stdio: "pipe",
      env: { ...process.env, npm_config_loglevel: "error" },
    });
    for (const name of consumerNames) {
      execFileSync(process.execPath, [join(root, name, "verify.mjs")], {
        cwd: join(root, name),
        stdio: "pipe",
      });
    }
    await rm(tarball, { force: true });
  }, 60_000);

  it("ships the attribution implementation exactly once", () => {
    const packed = dryRunPack();
    const ownershipFiles = packed.files
      .map((file) => file.path)
      .filter((path) => path.endsWith("anthropic-attribution.js"));
    expect(ownershipFiles).toEqual(["dist/anthropic-attribution.js"]);
  });
});
