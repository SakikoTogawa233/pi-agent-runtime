import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Buffer, sha256File, sha256Text } from "../src/canonical.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("canonical JSON and SHA-256", () => {
  it("sorts object keys recursively while preserving array order and JSON bytes", () => {
    const value = {
      z: [{ beta: 2, alpha: 1 }, 3],
      a: { y: true, x: "é" },
    };

    expect(canonicalJson(value)).toBe('{"a":{"x":"é","y":true},"z":[{"alpha":1,"beta":2},3]}');
  });

  it("rejects values that JSON would silently omit or coerce", () => {
    for (const value of [undefined, () => undefined, Symbol("value"), 1n, Number.NaN, Infinity]) {
      expect(() => canonicalJson(value)).toThrow(/JSON/);
    }
    expect(() => canonicalJson({ kept: true, omitted: undefined })).toThrow(/JSON/);
    expect(() => canonicalJson(["kept", undefined])).toThrow(/JSON/);
    expect(() => canonicalJson(Array(1))).toThrow(/JSON/);
    expect(() => canonicalJson(new Date(0))).toThrow(/JSON/);
    expect(() => canonicalJson(new Map([["key", "value"]]))).toThrow(/JSON/);
    const symbolKeyed = { kept: true, [Symbol("hidden")]: "lost" };
    expect(() => canonicalJson(symbolKeyed)).toThrow(/JSON/);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/JSON/);
  });

  it("matches the frozen SHA-256 vectors", async () => {
    const bytes = Buffer.from("agent-runtime\n", "utf8");
    const expected = "sha256:7f34e4e81784d50fe4d58698b3d6d044505132f6f763780c2f5623dfce884132";
    expect(sha256Buffer(bytes)).toBe(expected);
    expect(sha256Text("agent-runtime\n")).toBe(expected);

    const dir = await mkdtemp(join(tmpdir(), "pi-agent-runtime-canonical-"));
    tempDirectories.push(dir);
    const path = join(dir, "payload.bin");
    await writeFile(path, bytes);
    await expect(sha256File(path)).resolves.toEqual({ byteLength: bytes.length, sha256: expected });
  });
});
