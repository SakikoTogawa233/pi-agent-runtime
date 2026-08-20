import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPathContained,
  pathInside,
  replacePrivateFileDurable,
  resolveContainedPath,
  writePrivateFileDurable,
} from "../src/durable-fs.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-runtime-fs-"));
  tempDirectories.push(dir);
  return dir;
}

describe("private durable files", () => {
  it("creates private files and atomically replaces them without temp residue", async () => {
    const dir = await tempDir();
    const target = join(dir, "artifact.json");

    await writePrivateFileDurable(target, "first");
    expect((await stat(target)).mode & 0o777).toBe(0o600);

    await replacePrivateFileDurable(target, "second");
    expect(await readFile(target, "utf8")).toBe("second");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["artifact.json"]);
  });

  it("refuses to overwrite through the private-create primitive", async () => {
    const dir = await tempDir();
    const target = join(dir, "artifact.txt");
    await writeFile(target, "existing", { mode: 0o600 });

    await expect(writePrivateFileDurable(target, "replacement")).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("existing");
  });
});

describe("path containment", () => {
  it("accepts child paths including basenames that begin with two dots", () => {
    expect(pathInside("/tmp/root", "/tmp/root/a/b")).toBe(true);
    expect(pathInside("/tmp/root", "/tmp/root/..cache")).toBe(true);
    expect(resolveContainedPath("/tmp/root", "..cache/item")).toBe("/tmp/root/..cache/item");
    expect(resolveContainedPath("/tmp/root", "a/b")).toBe("/tmp/root/a/b");
    expect(() => assertPathContained("/tmp/root", "/tmp/root/a/b")).not.toThrow();
  });

  it("rejects traversal, absolute escape, and the parent itself", () => {
    expect(pathInside("/tmp/root", "/tmp/other")).toBe(false);
    expect(() => resolveContainedPath("/tmp/root", "../other")).toThrow(/stay inside/);
    expect(() => resolveContainedPath("/tmp/root", "/tmp/other")).toThrow(/relative/);
    expect(() => resolveContainedPath("/tmp/root", ".")).toThrow(/child path/);
  });
});
