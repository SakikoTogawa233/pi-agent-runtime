const LF = 0x0a;
const CR = 0x0d;

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(
      `Child protocol record is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseJsonRecord(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(
      `Child protocol record is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function encodeJsonLine(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

export class JsonLineDecoder<T> {
  private buffer = Buffer.alloc(0);

  constructor(private readonly decode: (value: unknown) => T) {}

  push(chunk: Buffer | string): T[] {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buffer = Buffer.concat([this.buffer, bytes]);
    const records: T[] = [];
    for (;;) {
      const newline = this.buffer.indexOf(LF);
      if (newline === -1) break;
      let line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.at(-1) === CR) line = line.subarray(0, line.length - 1);
      const text = decodeUtf8(line);
      records.push(this.decode(parseJsonRecord(text)));
    }
    return records;
  }

  finish(): T[] {
    if (this.buffer.length !== 0) {
      decodeUtf8(this.buffer);
      throw new Error("Child protocol JSONL record is not newline-terminated");
    }
    return [];
  }
}

export function encodePrefixedJsonFrame(prefix: string, value: unknown): Buffer {
  if (prefix.length === 0) throw new Error("Child protocol frame prefix must not be empty");
  return Buffer.concat([Buffer.from(prefix, "utf8"), encodeJsonLine(value)]);
}

export function parsePrefixedJsonFrames<T>(
  bytes: Buffer,
  prefix: string,
  decode: (value: unknown) => T,
): T[] {
  if (prefix.length === 0) throw new Error("Child protocol frame prefix must not be empty");
  const prefixBytes = Buffer.from(prefix, "utf8");
  const records: T[] = [];
  let cursor = 0;
  for (;;) {
    const frameStart = bytes.indexOf(prefixBytes, cursor);
    if (frameStart === -1) return records;
    const payloadStart = frameStart + prefixBytes.length;
    const newline = bytes.indexOf(LF, payloadStart);
    if (newline === -1) throw new Error("Child protocol prefixed frame is not newline-terminated");
    let payload = bytes.subarray(payloadStart, newline);
    if (payload.at(-1) === CR) payload = payload.subarray(0, payload.length - 1);
    const text = decodeUtf8(payload);
    records.push(decode(parseJsonRecord(text)));
    cursor = newline + 1;
  }
}
