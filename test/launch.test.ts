import { readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWindowsCommandLineWithinLimit,
  type PiLaunchDependencies,
  type PiLaunchSpec,
  resolvePiLaunch,
  spawnPiChild,
} from "../src/launch.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ root: string; cli: string; deps: PiLaunchDependencies }> {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-runtime-launch-"));
  tempDirectories.push(root);
  const packageRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  const manifest = join(packageRoot, "package.json");
  const cli = join(packageRoot, "dist", "cli.cjs");
  await mkdir(dirname(cli), { recursive: true });
  await writeFile(manifest, `${JSON.stringify({ bin: { pi: "dist/cli.cjs" } })}\n`);
  await writeFile(
    cli,
    "const fs=require('node:fs');const input=fs.readFileSync(0);process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin:input.toString('utf8')}));process.stderr.write('child-stderr');",
  );
  return {
    root,
    cli,
    deps: {
      platform: "win32",
      execPath: process.execPath,
      resolvePackageJson: () => manifest,
      readFile: readFileSync,
      realpath: realpathSync,
      stat: statSync,
    },
  };
}

describe("Pi launch", () => {
  it("uses the PATH executable on POSIX without package lookup", () => {
    let lookedUp = false;
    expect(
      resolvePiLaunch({
        platform: "linux",
        resolvePackageJson: () => {
          lookedUp = true;
          throw new Error("unexpected lookup");
        },
      }),
    ).toEqual({ executable: "pi", argvPrefix: [], kind: "path" });
    expect(lookedUp).toBe(false);
  });

  it("resolves and directly launches the packaged Windows Node CLI", async () => {
    const built = await fixture();
    const launch = resolvePiLaunch(built.deps);
    expect(launch).toEqual({
      executable: process.execPath,
      argvPrefix: [realpathSync(built.cli)],
      kind: "package-node-cli",
    });

    const capture = spawnPiChild({
      launch,
      piArgs: ["--mode", "json", "hello"],
      stdin: Buffer.from("seed-bytes", "utf8"),
      spawnOptions: { cwd: built.root, env: process.env },
      platform: "win32",
    });
    await expect(capture.completed).resolves.toEqual({
      code: 0,
      signal: null,
      stdout: Buffer.from('{"argv":["--mode","json","hello"],"stdin":"seed-bytes"}'),
      stderr: Buffer.from("child-stderr"),
    });
  });

  it("rejects escaped package bins and oversized Windows command lines loudly", async () => {
    const built = await fixture();
    const manifest = join(
      built.root,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "package.json",
    );
    const outside = join(built.root, "node_modules", "@earendil-works", "outside.cjs");
    await writeFile(outside, "");
    await writeFile(manifest, `${JSON.stringify({ bin: { pi: "../outside.cjs" } })}\n`);
    expect(() => resolvePiLaunch(built.deps)).toThrow(/outside the package root/);

    const launch: PiLaunchSpec = {
      executable: "C:\\Node\\node.exe",
      argvPrefix: ["C:\\pkg\\cli.js"],
      kind: "package-node-cli",
    };
    expect(() =>
      assertWindowsCommandLineWithinLimit(launch, ["secret".repeat(6000)], "win32", "test-stage"),
    ).toThrow(/pi_command_line_too_long: test-stage/);
  });
});
