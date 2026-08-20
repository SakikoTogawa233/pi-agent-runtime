import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type JsonObject = Readonly<Record<PropertyKey, unknown>>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonText(text: string): unknown {
  return JSON.parse(text) as unknown;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

export function sha256Buffer(buffer: Buffer): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

export function sha256Text(text: string): string {
  return sha256Buffer(Buffer.from(text, "utf8"));
}

export async function sha256File(path: string): Promise<{ byteLength: number; sha256: string }> {
  const bytes = await readFile(path);
  return { byteLength: bytes.length, sha256: sha256Buffer(bytes) };
}
