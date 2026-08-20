import { EventEmitter } from "node:events";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

class FakeStdin extends EventEmitter {
  endedWith: Buffer | undefined;

  end(data: Buffer): void {
    this.endedWith = data;
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
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

  it("resolves both string and object JavaScript bin manifests through Node", async () => {
    const built = await fixture();
    const manifest = join(
      built.root,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "package.json",
    );
    await writeFile(manifest, `${JSON.stringify({ bin: "dist/cli.cjs" })}\n`);
    expect(resolvePiLaunch(built.deps)).toEqual({
      executable: process.execPath,
      argvPrefix: [realpathSync(built.cli)],
      kind: "package-node-cli",
    });
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

  it("accepts a packaged CLI whose basename begins with two dots", async () => {
    const built = await fixture();
    const manifest = join(
      built.root,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "package.json",
    );
    const cli = join(dirname(manifest), "..cli.cjs");
    await writeFile(cli, "");
    await writeFile(manifest, `${JSON.stringify({ bin: { pi: "..cli.cjs" } })}\n`);

    expect(resolvePiLaunch(built.deps)).toEqual({
      executable: process.execPath,
      argvPrefix: [realpathSync(cli)],
      kind: "package-node-cli",
    });
  });

  it("uses one package-entry resolution strategy without a manifest-resolution fallback", async () => {
    const source = await readFile(new URL("../src/launch.ts", import.meta.url), "utf8");
    expect(source).not.toContain("createRequire");
    expect(source).not.toContain("package entry resolve failed");
  });

  it("permits native Windows package bins and rejects shell or unknown targets", async () => {
    const built = await fixture();
    const packageRoot = join(built.root, "node_modules", "@earendil-works", "pi-coding-agent");
    const manifest = join(packageRoot, "package.json");
    for (const extension of [".exe", ".com"]) {
      const target = join(packageRoot, "dist", `pi${extension}`);
      await writeFile(target, "");
      await writeFile(manifest, `${JSON.stringify({ bin: { pi: `dist/pi${extension}` } })}\n`);
      expect(resolvePiLaunch(built.deps)).toEqual({
        executable: realpathSync(target),
        argvPrefix: [],
        kind: "package-node-cli",
      });
    }
    for (const extension of [".cmd", ".bat", ".ps1", ".txt"]) {
      const target = join(packageRoot, "dist", `pi${extension}`);
      await writeFile(target, "");
      await writeFile(manifest, `${JSON.stringify({ bin: { pi: `dist/pi${extension}` } })}\n`);
      expect(() => resolvePiLaunch(built.deps)).toThrow(/extension is unsupported/);
    }
  });

  it("rejects malformed manifests, missing bins, and directory targets", async () => {
    const built = await fixture();
    const packageRoot = join(built.root, "node_modules", "@earendil-works", "pi-coding-agent");
    const manifest = join(packageRoot, "package.json");
    await writeFile(manifest, "{");
    expect(() => resolvePiLaunch(built.deps)).toThrow(/manifest JSON is invalid/);

    await writeFile(manifest, "{}\n");
    expect(() => resolvePiLaunch(built.deps)).toThrow(/bin\.pi is missing or malformed/);

    const directoryTarget = join(packageRoot, "dist", "directory.js");
    await mkdir(directoryTarget);
    await writeFile(manifest, `${JSON.stringify({ bin: { pi: "dist/directory.js" } })}\n`);
    expect(() => resolvePiLaunch(built.deps)).toThrow(/not a regular file/);
  });

  it("binds child stdin EPIPE into the returned completion promise", async () => {
    const child = new FakeChild();
    const stdin = Buffer.from("payload", "utf8");
    const capture = spawnPiChild({
      launch: { executable: "pi", argvPrefix: [], kind: "path" },
      piArgs: [],
      stdin,
      spawnOptions: {},
      platform: "linux",
      spawn: () => child as never,
    });

    expect(child.stdin.endedWith).toBe(stdin);
    expect(child.stdin.listenerCount("error")).toBe(1);
    const failure = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    child.stdin.emit("error", failure);
    child.emit("close", 1, null);
    await expect(capture.completed).rejects.toBe(failure);
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
    const secret = "SECRET_TOKEN_VALUE";
    expect(() =>
      assertWindowsCommandLineWithinLimit(launch, [secret.repeat(3000)], "win32", "test-stage"),
    ).toThrow(/pi_command_line_too_long: test-stage/);
    try {
      assertWindowsCommandLineWithinLimit(launch, [secret.repeat(3000)], "win32", "test-stage");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
