import type { Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.js";
import {
  projectVisibleConversation,
  resolveEffectiveLeaf,
  snapshotParentConversation,
  UnsupportedConversationBlockError,
} from "../src/context.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function messages(): Message[] {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "image", mimeType: "image/png", data: "RAW" },
      ],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "visible" },
        { type: "toolCall", id: "c1", name: "read", arguments: { z: 1, a: 2 } },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [
        { type: "text", text: "result" },
        { type: "image", mimeType: "image/jpeg", data: "TOOLRAW" },
      ],
      isError: false,
      timestamp: 3,
    },
  ];
}

describe("visible conversation projection", () => {
  it("preserves visible text and emits stable hash-accounted omission records", () => {
    const projected = projectVisibleConversation(messages());
    expect(projected.entries).toEqual([
      { kind: "text", source_ordinal: 0, block_ordinal: 0, role: "user", text: "hello" },
      {
        kind: "text",
        source_ordinal: 0,
        block_ordinal: 1,
        role: "user",
        text: "[Image omitted from child text transcript: image/png]",
      },
      {
        kind: "omitted_activity",
        at: [1, 1],
        bytes: 6,
        counts: { assistant_thinking: 1 },
      },
      { kind: "text", source_ordinal: 1, block_ordinal: 1, role: "assistant", text: "visible" },
      {
        kind: "omitted_activity",
        at: [1, 2],
        bytes: 19,
        counts: { tool_calls: 1, tool_result_texts: 1 },
      },
    ]);
    expect(projected.accounting).toMatchObject({
      included_user_text_bytes: 58,
      included_assistant_text_bytes: 7,
      omitted_thinking_bytes: 6,
      omitted_tool_call_argument_bytes: 13,
      omitted_tool_result_text_bytes: 6,
      omitted_tool_result_image_bytes: 7,
      ledger_root_sha256: "428b0994b6f86e920300ae685b8890aab04d212374b2d7810f3c30059c7f8956",
    });
    expect(projected.ledger.entries.map((entry) => entry.payload_sha256)).toEqual([
      "e564b4081d7a9ea4b00dada53bdae70c99b87b6fce869f0c3dd4d2bfa1e53e1c",
      "c2985c5ba6f7d2a55e768f92490ca09388e95bc4cccb9fdf11b15f4d42f93e73",
      "f6a214f7a5fcda0c2cee9660b7fc29f5649e3c68aad48e20e950137c98913a68",
      "d9452c90309289ad495fe9ba491d996c1371449e305ca8429d43ed76a956440b",
    ]);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toMatch(/RAW|TOOLRAW|hidden/);
    expect(serialized).not.toContain('"text":"result"');
  });

  it("is deterministic and changes only omission hashes for equal-length payload mutations", () => {
    const first = projectVisibleConversation(messages());
    const repeated = projectVisibleConversation(messages());
    expect(canonicalJson(first)).toBe(canonicalJson(repeated));

    const mutatedMessages = messages();
    const toolResult = mutatedMessages[2] as Extract<Message, { role: "toolResult" }>;
    toolResult.content = [
      { type: "text", text: "resulx" },
      { type: "image", mimeType: "image/jpeg", data: "TOOLRAW" },
    ];
    const mutated = projectVisibleConversation(mutatedMessages);
    expect(mutated.accounting.omitted_tool_result_text_bytes).toBe(
      first.accounting.omitted_tool_result_text_bytes,
    );
    expect(mutated.ledger.root_sha256).not.toBe(first.ledger.root_sha256);
    expect(canonicalJson(mutated)).not.toContain("resulx");
  });

  it("keeps a tool-heavy megabyte session bounded without exposing omitted payloads", () => {
    const argumentsPayload = { blob: "A".repeat(600_000) };
    const projected = projectVisibleConversation([
      { role: "user", content: "visible user sentinel", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "T".repeat(20_000) },
          { type: "text", text: "visible assistant sentinel" },
          { type: "toolCall", id: "large", name: "read", arguments: argumentsPayload },
        ],
        api: "openai-responses",
        provider: "openai",
        model: "test",
        usage,
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "large",
        toolName: "read",
        content: [{ type: "text", text: "R".repeat(700_000) }],
        isError: false,
        timestamp: 3,
      },
      { role: "user", content: "visible follow-up sentinel", timestamp: 4 },
    ]);
    const serialized = canonicalJson(projected);
    expect(serialized).toContain("visible user sentinel");
    expect(serialized).toContain("visible assistant sentinel");
    expect(serialized).toContain("visible follow-up sentinel");
    expect(serialized).not.toMatch(/A{100}|R{100}|T{100}/);
    expect(projected.accounting).toMatchObject({
      omitted_thinking_bytes: 20_000,
      omitted_tool_call_count: 1,
      omitted_tool_call_argument_bytes: Buffer.byteLength(canonicalJson(argumentsPayload), "utf8"),
      omitted_tool_result_text_count: 1,
      omitted_tool_result_text_bytes: 700_000,
      tool_call_names: [{ name: "read", calls: 1 }],
    });
  });

  it("collapses contiguous omissions into one source-ordered receipt", () => {
    const projected = projectVisibleConversation([
      { role: "user", content: "first", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "read", arguments: {} },
          { type: "toolCall", id: "c2", name: "read", arguments: {} },
        ],
        api: "openai-responses",
        provider: "openai",
        model: "test",
        usage,
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: "r1" }],
        isError: false,
        timestamp: 3,
      },
      {
        role: "toolResult",
        toolCallId: "c2",
        toolName: "read",
        content: [{ type: "text", text: "r2" }],
        isError: false,
        timestamp: 4,
      },
      { role: "user", content: "second", timestamp: 5 },
    ]);
    expect(projected.entries[1]).toEqual({
      kind: "omitted_activity",
      at: [1, 3],
      bytes: 8,
      counts: { tool_calls: 2, tool_result_texts: 2 },
    });
    expect(projected.ledger.entries.map((entry) => entry.index)).toEqual([0, 1, 2, 3]);
    expect(projected.ledger.projection_map[0]).toEqual({
      canonical_entry_index: 1,
      entry_kind: "omitted_activity",
      ledger_index_first: 0,
      ledger_index_last: 3,
    });
  });

  it("fails loudly for an unsupported message block", () => {
    expect(() =>
      projectVisibleConversation([
        {
          role: "assistant",
          content: [{ type: "future-block" }],
          api: "openai-responses",
          provider: "openai",
          model: "test",
          usage,
          stopReason: "stop",
          timestamp: 1,
        } as never,
      ]),
    ).toThrow(UnsupportedConversationBlockError);
  });
});

describe("parent snapshot", () => {
  it("requires the exact active tool-call id instead of falling back to a name match", () => {
    expect(() =>
      resolveEffectiveLeaf(
        {
          getLeafId: () => "leaf",
          getLeafEntry: () => undefined,
          getEntries: () => [],
        },
        { toolCallId: undefined as never, excludeActiveToolCallLeaf: true },
      ),
    ).toThrow(/toolCallId/);
  });

  it("rejects a malformed message leaf instead of silently keeping it", () => {
    expect(() =>
      resolveEffectiveLeaf(
        {
          getLeafId: () => "leaf",
          getLeafEntry: () =>
            ({ id: "leaf", parentId: null, type: "message", message: null }) as never,
          getEntries: () => [],
        },
        { toolCallId: "active", excludeActiveToolCallLeaf: true },
      ),
    ).toThrow(/message leaf/i);
  });

  it("excludes the active tool-call leaf and every sibling call in that assistant message", () => {
    const session = SessionManager.inMemory("/tmp/project");
    session.appendMessage({ role: "user", content: "root question", timestamp: 1 });
    session.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "partial text" },
        { type: "toolCall", id: "active", name: "subagent_run", arguments: {} },
        { type: "toolCall", id: "sibling", name: "read", arguments: { path: "secret" } },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage,
      stopReason: "toolUse",
      timestamp: 2,
    });

    const snapshot = snapshotParentConversation(
      { cwd: "/tmp/project", sessionManager: session, getSystemPrompt: () => "system" },
      { toolCallId: "active", excludeActiveToolCallLeaf: true },
    );
    expect(snapshot.activeToolCallLeafExcluded).toBe(true);
    expect(JSON.stringify(snapshot.messages)).toContain("root question");
    expect(JSON.stringify(snapshot.messages)).not.toMatch(/partial text|sibling|secret/);
  });
});
