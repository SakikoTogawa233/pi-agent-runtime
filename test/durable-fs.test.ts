import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPathContained,
  createDurableFileWriter,
  type DurableData,
  type DurableDirectoryHandle,
  type DurableFileError,
  type DurableFileOperations,
  type DurableWritableHandle,
  type DurableWriteFlag,
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

type RecordedCall =
  | { kind: "openWritable"; path: string; flag: DurableWriteFlag; mode: number | undefined }
  | { kind: "writeFile"; path: string; data: DurableData }
  | {
      kind: "syncFile" | "closeFile" | "openDirectory" | "syncDirectory" | "closeDirectory";
      path: string;
    }
  | { kind: "rename"; source: string; target: string }
  | { kind: "remove"; path: string };

class RecordingOperations implements DurableFileOperations {
  readonly platform: NodeJS.Platform;
  readonly calls: RecordedCall[] = [];
  openDirectoryError: Error | undefined;
  syncDirectoryError: Error | undefined;
  closeDirectoryError: Error | undefined;

  constructor(platform: NodeJS.Platform = "linux") {
    this.platform = platform;
  }

  async openWritable(
    path: string,
    flag: DurableWriteFlag,
    mode?: number,
  ): Promise<DurableWritableHandle> {
    this.calls.push({ kind: "openWritable", path, flag, mode });
    return {
      writeFile: async (data) => {
        this.calls.push({ kind: "writeFile", path, data });
      },
      sync: async () => {
        this.calls.push({ kind: "syncFile", path });
      },
      close: async () => {
        this.calls.push({ kind: "closeFile", path });
      },
    };
  }

  async openDirectory(path: string): Promise<DurableDirectoryHandle> {
    this.calls.push({ kind: "openDirectory", path });
    if (this.openDirectoryError !== undefined) throw this.openDirectoryError;
    return {
      sync: async () => {
        this.calls.push({ kind: "syncDirectory", path });
        if (this.syncDirectoryError !== undefined) throw this.syncDirectoryError;
      },
      close: async () => {
        this.calls.push({ kind: "closeDirectory", path });
        if (this.closeDirectoryError !== undefined) throw this.closeDirectoryError;
      },
    };
  }

  async rename(source: string, target: string): Promise<void> {
    this.calls.push({ kind: "rename", source, target });
  }

  async remove(path: string): Promise<void> {
    this.calls.push({ kind: "remove", path });
  }

  temporaryPath(target: string): string {
    return `${target}.tmp`;
  }
}

function callKinds(operations: RecordingOperations): string[] {
  return operations.calls.map((call) => call.kind);
}

describe("durable file writer sequencing", () => {
  it("keeps the frozen atomic replacement sequence", async () => {
    const operations = new RecordingOperations();
    const writer = createDurableFileWriter(operations);

    await writer.replace("/virtual/target.txt", "data");

    expect(callKinds(operations)).toEqual([
      "openWritable",
      "writeFile",
      "syncFile",
      "closeFile",
      "rename",
      "openDirectory",
      "syncDirectory",
      "closeDirectory",
    ]);
    expect(operations.calls[0]).toEqual({
      kind: "openWritable",
      path: "/virtual/target.txt.tmp",
      flag: "wx",
      mode: 0o600,
    });
  });

  it("syncs the containing directory after direct public and private file creation", async () => {
    for (const method of ["write", "writePrivate"] as const) {
      const operations = new RecordingOperations();
      const writer = createDurableFileWriter(operations);

      await writer[method]("/virtual/created.txt", "data");

      expect(callKinds(operations)).toEqual([
        "openWritable",
        "writeFile",
        "syncFile",
        "closeFile",
        "openDirectory",
        "syncDirectory",
        "closeDirectory",
      ]);
    }
  });

  it("reports direct-create directory sync failure instead of claiming durability", async () => {
    const operations = new RecordingOperations();
    operations.syncDirectoryError = new Error("directory sync failed");
    const writer = createDurableFileWriter(operations);

    await expect(writer.writePrivate("/virtual/created.txt", "data")).rejects.toMatchObject({
      operation: "sync_directory",
      path: "/virtual",
      renameCompleted: false,
    } satisfies Partial<DurableFileError>);
    expect(callKinds(operations)).toEqual([
      "openWritable",
      "writeFile",
      "syncFile",
      "closeFile",
      "openDirectory",
      "syncDirectory",
      "closeDirectory",
    ]);
  });

  it("reports every direct-create directory durability failure", async () => {
    for (const operation of ["open_directory", "sync_directory", "close_directory"] as const) {
      const operations = new RecordingOperations();
      const failure = new Error(`${operation} failed`);
      if (operation === "open_directory") operations.openDirectoryError = failure;
      else if (operation === "sync_directory") operations.syncDirectoryError = failure;
      else operations.closeDirectoryError = failure;
      const writer = createDurableFileWriter(operations);

      await expect(writer.writePrivate("/virtual/created.txt", "data")).rejects.toMatchObject({
        operation,
        path: "/virtual",
        primaryCause: failure,
        renameCompleted: false,
      } satisfies Partial<DurableFileError>);
    }
  });

  it("marks replacement directory failures as post-rename", async () => {
    const operations = new RecordingOperations();
    operations.openDirectoryError = new Error("directory open failed");
    const writer = createDurableFileWriter(operations);

    await expect(writer.replace("/virtual/target.txt", "data")).rejects.toMatchObject({
      operation: "open_directory",
      path: "/virtual",
      renameCompleted: true,
    } satisfies Partial<DurableFileError>);
  });

  it("keeps the Windows direct-write sequence handle-scoped", async () => {
    const operations = new RecordingOperations("win32");
    const writer = createDurableFileWriter(operations);

    await writer.writePrivate("C:\\virtual\\created.txt", "data");

    expect(callKinds(operations)).toEqual(["openWritable", "writeFile", "syncFile", "closeFile"]);
  });
});

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
  it("accepts existing, new, and internally symlinked child paths", async () => {
    const root = await tempDir();
    const directory = join(root, "artifacts");
    const existing = join(directory, "existing.json");
    await mkdir(directory);
    await writeFile(existing, "existing");
    await symlink(directory, join(root, "inside-link"), "dir");

    expect(resolveContainedPath(root, "artifacts/existing.json")).toBe(existing);
    expect(resolveContainedPath(root, "artifacts/new.json")).toBe(join(directory, "new.json"));
    expect(resolveContainedPath(root, "future/nested/new.json")).toBe(
      join(root, "future/nested/new.json"),
    );
    expect(resolveContainedPath(root, "inside-link/new.json")).toBe(
      join(root, "inside-link/new.json"),
    );
  });

  it("rejects existing symlink components that redirect new or existing paths outside the root", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFile(join(outside, "existing.json"), "outside");
    await symlink(outside, join(root, "escape"), "dir");

    expect(() => resolveContainedPath(root, "escape/new.json")).toThrow(/stay inside/);
    expect(() => resolveContainedPath(root, "escape/existing.json")).toThrow(/stay inside/);
    expect(await readdir(outside)).toEqual(["existing.json"]);
  });

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
