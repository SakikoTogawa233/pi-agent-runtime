import { describe, expect, it } from "vitest";
import {
  encodeJsonLine,
  encodePrefixedJsonFrame,
  JsonLineDecoder,
  parsePrefixedJsonFrames,
} from "../src/protocol.js";

describe("child protocol framing", () => {
  it("encodes canonical LF-delimited JSON without treating Unicode separators as records", () => {
    expect(encodeJsonLine({ value: "a\u2028b\u2029c" }).toString("utf8")).toBe(
      '{"value":"a b c"}\n',
    );
  });

  it("pins every valid top-level JSON scalar and container record", () => {
    expect(
      [null, true, 3, "text", [1, 2], { value: 1 }].map((value) =>
        encodeJsonLine(value).toString("utf8"),
      ),
    ).toEqual(["null\n", "true\n", "3\n", '"text"\n', "[1,2]\n", '{"value":1}\n']);
  });

  it("rejects top-level values that cannot form an injective JSON record", () => {
    for (const value of [undefined, () => undefined, Symbol("value"), -0]) {
      expect(() => encodeJsonLine(value)).toThrow(/JSON/);
    }
  });

  it("decodes chunked UTF-8 JSONL and accepts CRLF by stripping only the trailing CR", () => {
    const decoder = new JsonLineDecoder((value) => value as { value: string });
    expect(decoder.push(Buffer.from('{"value":"hé'))).toEqual([]);
    expect(decoder.push(Buffer.from('llo"}\r\n{"value":"two"}\n'))).toEqual([
      { value: "héllo" },
      { value: "two" },
    ]);
    expect(decoder.finish()).toEqual([]);
  });

  it("rejects malformed UTF-8, malformed JSON, and unterminated records", () => {
    const invalidUtf8 = new JsonLineDecoder((value) => value);
    expect(() => invalidUtf8.push(Buffer.from([0xc3, 0x28, 0x0a]))).toThrow(/UTF-8/);

    const invalidJson = new JsonLineDecoder((value) => value);
    expect(() => invalidJson.push("{]\n")).toThrow(/invalid JSON/);

    const unterminated = new JsonLineDecoder((value) => value);
    unterminated.push('{"ok":true}');
    expect(() => unterminated.finish()).toThrow(/newline-terminated/);
  });

  it("round-trips the frozen prefixed bytes amid stderr noise and rejects truncated frames", () => {
    const prefix = "\u001ePI_AGENT_RUNTIME_RESULT ";
    expect(encodePrefixedJsonFrame(prefix, { ordinal: 1 }).toString("utf8")).toBe(
      '\u001ePI_AGENT_RUNTIME_RESULT {"ordinal":1}\n',
    );
    const first = encodePrefixedJsonFrame(prefix, { ordinal: 1 });
    const second = encodePrefixedJsonFrame(prefix, { ordinal: 2 });
    const stderr = Buffer.concat([
      Buffer.from("diagnostic\n"),
      first,
      Buffer.from("more noise\n"),
      second,
    ]);
    expect(
      parsePrefixedJsonFrames(stderr, prefix, (value) => value as { ordinal: number }),
    ).toEqual([{ ordinal: 1 }, { ordinal: 2 }]);
    expect(() =>
      parsePrefixedJsonFrames(Buffer.from(`${prefix}{"ordinal":1}`), prefix, (value) => value),
    ).toThrow(/newline-terminated/);
  });
});
