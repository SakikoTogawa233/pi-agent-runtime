import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  syncDirectoryError: Error | undefined;

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
    return {
      sync: async () => {
        this.calls.push({ kind: "syncDirectory", path });
        if (this.syncDirectoryError !== undefined) throw this.syncDirectoryError;
      },
      close: async () => {
        this.calls.push({ kind: "closeDirectory", path });
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
