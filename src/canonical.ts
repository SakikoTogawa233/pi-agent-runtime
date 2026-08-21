import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { assertJsonValue, sortJsonValue } from "./json-value.js";

export type JsonObject = Readonly<Record<PropertyKey, unknown>>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonText(text: string): unknown {
  return JSON.parse(text) as unknown;
}

export function canonicalJson(value: unknown): string {
  assertJsonValue(value);
  return JSON.stringify(sortJsonValue(value)) as string;
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
