import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_ATTRIBUTION_CLAIM_CHANNEL,
  type AnthropicAttributionExtensionHost,
  type AnthropicContextLike,
  buildAnthropicRequestParams,
  createAnthropicAttributionExtension,
  type PiModelLike,
  type PiSimpleStreamOptions,
  resolveCacheRetentionPreference,
  rewriteAnthropicRequestPayload,
  streamAnthropicViaBetaMessages,
} from "../src/anthropic-attribution.js";

const badLines = [
  "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)",
  "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)",
  "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

const anthropicModel: PiModelLike = {
  provider: "anthropic",
  id: "claude-sonnet-4-5",
  maxTokens: 64_000,
  reasoning: true,
};

function context(provider = "anthropic"): AnthropicContextLike {
  return {
    model: {
      provider,
      id: provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-5.5",
      maxTokens: 64_000,
      reasoning: true,
    },
    sessionManager: {
      getSessionId: () => "11111111-2222-4333-8444-555555555555",
    },
  };
}

class SynchronousBus {
  private readonly handlers = new Map<string, Array<(data: unknown) => void>>();

  emit(channel: string, data: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? [];
    handlers.push(handler);
    this.handlers.set(channel, handlers);
    return () => {
      this.handlers.set(
        channel,
        handlers.filter((candidate) => candidate !== handler),
      );
    };
  }

  listenerCount(channel: string): number {
    return this.handlers.get(channel)?.length ?? 0;
  }
}

function recordingHost(bus: SynchronousBus): {
  host: AnthropicAttributionExtensionHost;
  providers: unknown[];
  handlers: Array<(event: { payload: unknown }, ctx: AnthropicContextLike) => unknown>;
} {
  const providers: unknown[] = [];
  const handlers: Array<(event: { payload: unknown }, ctx: AnthropicContextLike) => unknown> = [];
  const host = {
    events: bus,
    registerProvider: (_name: string, config: unknown): void => {
      providers.push(config);
    },
    on: (
      _eventName: string,
      handler: (event: { payload: unknown }, ctx: AnthropicContextLike) => unknown,
    ): void => {
      handlers.push(handler);
    },
  };
  return {
    host: host as unknown as AnthropicAttributionExtensionHost,
    providers,
    handlers,
  };
}

describe("Anthropic request contracts", () => {
  it("rejects malformed direct cache retention instead of degrading it to short retention", () => {
    expect(() =>
      resolveCacheRetentionPreference({ cacheRetention: "invalid" as never, env: {} }),
    ).toThrow(/cacheRetention/);
    expect(() =>
      buildAnthropicRequestParams(
        anthropicModel,
        { messages: [{ role: "user", content: "hello" }] },
        { cacheRetention: "invalid" as never, env: {} },
      ),
    ).toThrow(/cacheRetention/);
  });

  it("rejects unknown user, tool-result, and assistant content blocks", () => {
    const malformedMessages = [
      [{ role: "user", content: [{ type: "audio", mimeType: "audio/wav", data: "AA==" }] }],
      [
        {
          role: "toolResult",
          toolCallId: "call-1",
          content: [{ type: "file", mimeType: "application/pdf", data: "AA==" }],
        },
      ],
      [{ role: "assistant", content: [{ type: "future", value: "not representable" }] }],
      [{ role: "assistant", content: [{ type: "text", text: 42 }] }],
    ];

    for (const messages of malformedMessages) {
      expect(() =>
        buildAnthropicRequestParams(anthropicModel, { messages: messages as never }, {
          cacheRetention: "none",
        }),
      ).toThrow(/message|content block/i);
    }
  });

  it("rejects unknown message roles and incomplete thinking blocks", () => {
    expect(() =>
      buildAnthropicRequestParams(
        anthropicModel,
        { messages: [{ role: "future", content: "ignored" }] as never },
        { cacheRetention: "none" },
      ),
    ).toThrow(/message role/i);
    expect(() =>
      buildAnthropicRequestParams(
        anthropicModel,
        {
          messages: [
            {
              role: "assistant",
              content: [{ type: "thinking", thinking: "reasoning without signature" }],
            },
          ],
        },
        { cacheRetention: "none" },
      ),
    ).toThrow(/thinkingSignature/);
  });

  it("rejects a conversation that converts to no Anthropic messages", () => {
    expect(() =>
      buildAnthropicRequestParams(anthropicModel, { messages: [] }, { cacheRetention: "none" }),
    ).toThrow(/at least one message/);
  });

  it("does not invent missing tool descriptions or temperature options", () => {
    const params = buildAnthropicRequestParams(
      anthropicModel,
      {
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "read",
            parameters: { type: "object", properties: {}, required: [] },
          },
        ],
      },
      { cacheRetention: "none" },
    );
    expect(params).not.toHaveProperty("temperature");
    expect((params.tools as Array<Record<string, unknown>>)[0]).not.toHaveProperty("description");
  });

  it("rejects malformed system blocks instead of preserving them as a fallback path", () => {
    expect(() =>
      rewriteAnthropicRequestPayload({
        payload: {
          model: "claude-sonnet-4-5",
          max_tokens: 64_000,
          system: [42],
          messages: [{ role: "user", content: "hello" }],
        },
        ctx: context(),
        account: { deviceId: "device", accountUuid: "account" },
        headerRegistered: true,
        cacheRetention: "none",
      }),
    ).toThrow(/system block/i);
  });
});

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function successfulSse(text = "hello"): string {
  return [
    sseEvent("message_start", {
      type: "message_start",
      message: { id: "msg-1" },
    }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ].join("");
}

function streamOptions(overrides: Partial<PiSimpleStreamOptions> = {}): PiSimpleStreamOptions {
  return {
    apiKey: "sk-ant-oat-test-token",
    cacheRetention: "none",
    onPayload: (payload) => ({
      ...payload,
      metadata: {
        user_id: JSON.stringify({ session_id: "11111111-2222-4333-8444-555555555555" }),
      },
    }),
    ...overrides,
  };
}

async function streamedResult(
  body: string,
  options: PiSimpleStreamOptions = streamOptions(),
): Promise<Awaited<ReturnType<ReturnType<typeof streamAnthropicViaBetaMessages>["result"]>>> {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
  return streamAnthropicViaBetaMessages(
    anthropicModel,
    { messages: [{ role: "user", content: "hello" }] },
    options,
  ).result();
}

describe("Anthropic beta messages transport", () => {
  it("completes only after a valid message_stop sequence", async () => {
    await expect(streamedResult(successfulSse())).resolves.toMatchObject({
      stopReason: "stop",
      responseId: "msg-1",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("turns provider SSE error events into error settlement", async () => {
    const result = await streamedResult(
      sseEvent("error", {
        type: "error",
        error: { type: "overloaded_error", message: "capacity exhausted" },
      }),
    );
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/capacity exhausted/);
  });

  it("rejects unknown and out-of-order SSE event sequences", async () => {
    const malformedBodies = [
      [
        sseEvent("message_start", { type: "message_start", message: { id: "msg-1" } }),
        sseEvent("future_event", { type: "future_event" }),
        sseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
        }),
        sseEvent("message_stop", { type: "message_stop" }),
      ].join(""),
      [
        sseEvent("message_start", { type: "message_start", message: { id: "msg-1" } }),
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: 9,
          delta: { type: "text_delta", text: "orphan" },
        }),
        sseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
        }),
        sseEvent("message_stop", { type: "message_stop" }),
      ].join(""),
      [
        sseEvent("message_start", { type: "message_start", message: {} }),
        sseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
        }),
        sseEvent("message_stop", { type: "message_stop" }),
      ].join(""),
    ];

    for (const body of malformedBodies) {
      const result = await streamedResult(body);
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toMatch(/SSE|sequence|response id|content block/i);
    }
  });

  it("rejects EOF without message_stop and an unterminated final SSE record", async () => {
    const missingStop = [
      sseEvent("message_start", { type: "message_start", message: { id: "msg-1" } }),
      sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
      }),
    ].join("");
    const incompleteStop = `${missingStop}event: message_stop\ndata: {"type":"message_stop"}`;

    for (const body of [missingStop, incompleteStop]) {
      const result = await streamedResult(body);
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toMatch(/message_stop|unterminated|incomplete/i);
    }
  });

  it("retries retryable HTTP failures according to maxRetries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503, statusText: "Unavailable" }))
      .mockResolvedValueOnce(new Response(successfulSse("retried"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamAnthropicViaBetaMessages(
      anthropicModel,
      { messages: [{ role: "user", content: "hello" }] },
      streamOptions({ maxRetries: 1 }),
    ).result();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ stopReason: "stop", content: [{ text: "retried" }] });
  });

  it("enforces timeoutMs on the request instead of leaving it inert", async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (!(init?.signal instanceof AbortSignal)) throw new Error("request signal missing");
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamAnthropicViaBetaMessages(
      anthropicModel,
      { messages: [{ role: "user", content: "hello" }] },
      streamOptions({ timeoutMs: 5 }),
    ).result();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/timed out after 5 ms/);
  });

  it("rejects an onPayload result containing unsupported JSON before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await streamAnthropicViaBetaMessages(
      anthropicModel,
      { messages: [{ role: "user", content: "hello" }] },
      streamOptions({
        onPayload: (payload) => ({
          ...payload,
          metadata: {
            user_id: JSON.stringify({ session_id: "11111111-2222-4333-8444-555555555555" }),
          },
          unsupported: undefined,
        }),
      }),
    ).result();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/JSON/);
  });

  it("rejects malformed timeout and retry options before transport", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const options of [{ timeoutMs: 0 }, { maxRetries: -1 }, { maxRetries: 1.5 }]) {
      const result = await streamAnthropicViaBetaMessages(
        anthropicModel,
        { messages: [{ role: "user", content: "hello" }] },
        streamOptions(options),
      ).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toMatch(/timeoutMs|maxRetries/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Anthropic attribution and sanitization", () => {
  it("preserves the extracted payload bytes except for attribution and exact-line sanitization", () => {
    const original = {
      model: "claude-sonnet-4-5",
      max_tokens: 64_000,
      system: [
        {
          type: "text",
          text: ["keep before", ...badLines, "keep after"].join("\n"),
          cache_control: { type: "ephemeral", ttl: "1h" },
          custom_field: "preserved",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    };
    const rewritten = rewriteAnthropicRequestPayload({
      payload: original,
      ctx: context(),
      account: {
        deviceId: "d".repeat(64),
        accountUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      },
      headerRegistered: true,
      cacheRetention: undefined,
    }) as Record<string, unknown>;
    expect(JSON.stringify(rewritten)).not.toContain(badLines[0]);
    expect(JSON.stringify(rewritten)).not.toContain(badLines[1]);
    expect(JSON.stringify(rewritten)).not.toContain(badLines[2]);
    expect(JSON.stringify(rewritten)).toContain("keep before\\nkeep after");
    expect(JSON.stringify(rewritten)).toContain("x-anthropic-billing-header:");
    expect(JSON.stringify(rewritten)).toContain("Claude Agent SDK");
    expect(rewritten.metadata).toEqual({
      user_id: JSON.stringify({
        account_uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        device_id: "d".repeat(64),
        session_id: "11111111-2222-4333-8444-555555555555",
      }),
    });
  });

  it("does not apply Anthropic behavior to another provider and rejects malformed input", () => {
    const payload = { model: "gpt-5.5" };
    expect(
      rewriteAnthropicRequestPayload({
        payload,
        ctx: context("openai-codex"),
        account: { deviceId: "d", accountUuid: "a" },
        headerRegistered: true,
        cacheRetention: undefined,
      }),
    ).toBeUndefined();
    expect(() =>
      rewriteAnthropicRequestPayload({
        payload: [],
        ctx: context(),
        account: { deviceId: "d", accountUuid: "a" },
        headerRegistered: true,
        cacheRetention: undefined,
      }),
    ).toThrow(/JSON object/);
  });

  it("lets exactly one runtime-owned factory claim the child attribution hooks and registers no commands or UI", () => {
    const bus = new SynchronousBus();
    const first = recordingHost(bus);
    const second = recordingHost(bus);
    const extension = createAnthropicAttributionExtension({
      loadAccount: () => ({ deviceId: "device", accountUuid: "account" }),
    });

    extension(first.host);
    extension(second.host);

    expect(first.providers).toHaveLength(1);
    expect(first.handlers).toHaveLength(1);
    expect(second.providers).toHaveLength(0);
    expect(second.handlers).toHaveLength(0);
    expect(bus.listenerCount(ANTHROPIC_ATTRIBUTION_CLAIM_CHANNEL)).toBe(1);
    expect(Object.keys(first.host).sort()).toEqual(["events", "on", "registerProvider"]);
  });
});
