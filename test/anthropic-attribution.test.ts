import { Type } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { type ProviderConfig, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_ATTRIBUTION_CLAIM_CHANNEL,
  type AnthropicAttributionExtensionHost,
  type AnthropicContextLike,
  buildAnthropicRequestParams,
  createAnthropicAttributionExtension,
  type PiModelLike,
  type PiSimpleStreamOptions,
  type PiStreamContext,
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
  vi.unstubAllEnvs();
});

const anthropicModel: PiModelLike = {
  ...ANTHROPIC_MODELS["claude-sonnet-4-5"],
  compat: {
    ...ANTHROPIC_MODELS["claude-sonnet-4-5"].compat,
    supportsLongCacheRetention: true,
    supportsCacheControlOnTools: true,
  },
};

const pricedAnthropicModel: PiModelLike = anthropicModel;
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const sessionManager = SessionManager.inMemory();
const TEST_SESSION_ID = sessionManager.getSessionId();
const TEST_ACCOUNT = {
  deviceId: "d".repeat(64),
  accountUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
} as const;

function userContext(content = "hello"): PiStreamContext {
  return { messages: [{ role: "user", content, timestamp: 1 }] };
}

function context(provider = "anthropic"): AnthropicContextLike {
  return {
    model:
      provider === "anthropic"
        ? anthropicModel
        : {
            ...anthropicModel,
            provider,
            id: "gpt-5.5",
            api: "openai-responses",
          },
    sessionManager,
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
  it("requires an explicit cache policy and accepts omitted host capability booleans", () => {
    expect(() => resolveCacheRetentionPreference({ env: {} })).toThrow(
      /cache retention.*required/i,
    );
    expect(() =>
      buildAnthropicRequestParams({ ...anthropicModel, compat: undefined }, userContext(), {
        cacheRetention: "short",
      }),
    ).not.toThrow();
    expect(() =>
      buildAnthropicRequestParams(
        {
          ...anthropicModel,
          compat: { supportsLongCacheRetention: false, supportsCacheControlOnTools: true },
        },
        userContext(),
        { cacheRetention: "long" },
      ),
    ).toThrow(/long cache retention/);
  });

  it("overlays scoped provider env on process env and validates explicit malformed values", () => {
    vi.stubEnv("PI_CACHE_RETENTION", "long");
    expect(resolveCacheRetentionPreference({ env: {} })).toBe("long");
    expect(resolveCacheRetentionPreference({ env: { PI_CACHE_RETENTION: "short" } })).toBe("short");
    expect(resolveCacheRetentionPreference({ cacheRetention: "none", env: {} }, "long")).toBe(
      "none",
    );
    vi.stubEnv("PI_CACHE_RETENTION", "short");
    expect(() =>
      resolveCacheRetentionPreference({ env: { PI_CACHE_RETENTION: "LONG" } }),
    ).toThrow(/PI_CACHE_RETENTION/);
    for (const invalid of ["", "LONG", "invalid", null, 1]) {
      expect(() =>
        resolveCacheRetentionPreference({ cacheRetention: invalid as never, env: {} }),
      ).toThrow(/cacheRetention/);
    }
    expect(() =>
      buildAnthropicRequestParams(anthropicModel, userContext(), {
        cacheRetention: "invalid" as never,
        env: {},
      }),
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
        buildAnthropicRequestParams(
          anthropicModel,
          { messages: messages as never },
          {
            cacheRetention: "none",
          },
        ),
      ).toThrow(/message|content block/i);
    }
  });

  it("preserves frozen supplementary Unicode vectors and replaces only unpaired surrogates", () => {
    const nonBmp = "😀𝄞𠜎";
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xde00);
    const params = buildAnthropicRequestParams(
      anthropicModel,
      {
        messages: [
          {
            role: "user",
            content: `user ${nonBmp} ${high}A${low}${high}${low}`,
            timestamp: 1,
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: `assistant ${nonBmp}` },
              {
                type: "thinking",
                thinking: `thinking ${nonBmp}`,
                thinkingSignature: "signature",
              },
            ],
            api: "anthropic-messages",
            provider: "anthropic",
            model: anthropicModel.id,
            usage: zeroUsage,
            stopReason: "stop",
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: `tool ${nonBmp}` }],
            isError: false,
            timestamp: 3,
          },
        ],
      },
      { cacheRetention: "none" },
    );

    expect(params.messages).toEqual([
      { role: "user", content: `user ${nonBmp} �A�${high}${low}` },
      {
        role: "assistant",
        content: [
          { type: "text", text: `assistant ${nonBmp}` },
          {
            type: "thinking",
            thinking: `thinking ${nonBmp}`,
            signature: "signature",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: `tool ${nonBmp}`,
            is_error: false,
          },
        ],
      },
    ]);
  });

  it("requires an explicit tool-result isError boolean", () => {
    expect(() =>
      buildAnthropicRequestParams(
        anthropicModel,
        {
          messages: [
            {
              role: "toolResult",
              toolCallId: "call-1",
              content: [{ type: "text", text: "result" }],
            },
          ] as never,
        },
        { cacheRetention: "none" },
      ),
    ).toThrow(/isError.*boolean/);
  });

  it("accepts host-valid unsigned interrupted thinking without inventing a signature", () => {
    const params = buildAnthropicRequestParams(
      anthropicModel,
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "interrupted reasoning" }],
          },
        ] as never,
      },
      { cacheRetention: "none" },
    );
    expect(params.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "interrupted reasoning" }],
      },
    ]);
  });

  it("rejects unknown message roles and malformed thinking blocks", () => {
    expect(() =>
      buildAnthropicRequestParams(
        anthropicModel,
        { messages: [{ role: "future", content: "ignored" }] as never },
        { cacheRetention: "none" },
      ),
    ).toThrow(/message role/i);
    for (const content of [
      [{ type: "thinking", thinking: 42 }],
      [{ type: "thinking", thinking: "redacted", redacted: true }],
    ]) {
      expect(() =>
        buildAnthropicRequestParams(
          anthropicModel,
          { messages: [{ role: "assistant", content }] as never },
          { cacheRetention: "none" },
        ),
      ).toThrow(/thinking|thinkingSignature/);
    }
  });

  it("rejects a conversation that converts to no Anthropic messages", () => {
    expect(() =>
      buildAnthropicRequestParams(anthropicModel, { messages: [] }, { cacheRetention: "none" }),
    ).toThrow(/at least one message/);
  });

  it("preserves host tool descriptions without inventing temperature options", () => {
    const params = buildAnthropicRequestParams(
      anthropicModel,
      {
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: Type.Object({}),
          },
        ],
      },
      { cacheRetention: "none" },
    );
    expect(params).not.toHaveProperty("temperature");
    expect((params.tools as Array<Record<string, unknown>>)[0]).toHaveProperty(
      "description",
      "Read a file",
    );
  });

  it("matches Anthropic strict-tool capability and constrained sampling semantics", () => {
    const strictTool = {
      name: "strict_read",
      description: "Read exactly",
      parameters: Type.Object({ path: Type.String(), note: Type.Optional(Type.String()) }),
      constrainedSampling: { type: "json_schema", strict: "require" },
    } as const;
    const supported = buildAnthropicRequestParams(
      { ...anthropicModel, compat: { ...anthropicModel.compat, supportsStrictTools: true } },
      { ...userContext(), tools: [strictTool] },
      { cacheRetention: "none" },
    );
    expect((supported.tools as Array<Record<string, unknown>>)[0]).toMatchObject({
      strict: true,
      input_schema: {
        type: "object",
        required: ["path", "note"],
        additionalProperties: false,
      },
    });

    expect(() =>
      buildAnthropicRequestParams(
        { ...anthropicModel, compat: { ...anthropicModel.compat, supportsStrictTools: false } },
        { ...userContext(), tools: [strictTool] },
        { cacheRetention: "none" },
      ),
    ).toThrow(/requires JSON-schema constrained sampling.*unsupported/i);

    const preferred = buildAnthropicRequestParams(
      { ...anthropicModel, compat: { ...anthropicModel.compat, supportsStrictTools: false } },
      {
        ...userContext(),
        tools: [{ ...strictTool, constrainedSampling: { type: "json_schema", strict: "prefer" } }],
      },
      { cacheRetention: "none" },
    );
    expect((preferred.tools as Array<Record<string, unknown>>)[0]).not.toHaveProperty("strict");

    expect(() =>
      buildAnthropicRequestParams(
        anthropicModel,
        {
          ...userContext(),
          tools: [
            {
              ...strictTool,
              constrainedSampling: {
                type: "grammar",
                variants: { openai_lark: "start: /.+/" },
              },
            },
          ],
        },
        { cacheRetention: "none" },
      ),
    ).toThrow(/grammar constrained sampling.*Anthropic/i);
  });

  it("requires a first user text for attribution instead of inventing an empty fingerprint input", () => {
    expect(() =>
      rewriteAnthropicRequestPayload({
        payload: {
          model: "claude-sonnet-4-5",
          max_tokens: 64_000,
          messages: [{ role: "assistant", content: [{ type: "text", text: "prefill" }] }],
        },
        ctx: context(),
        account: { deviceId: "device", accountUuid: "account" },
        headerRegistered: true,
        cacheRetention: "none",
      }),
    ).toThrow(/first user text/i);
  });

  it("does not infer cache policy from incoming markers", () => {
    const original = {
      model: "claude-sonnet-4-5",
      max_tokens: 64_000,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
        },
      ],
    };
    const rewritten = rewriteAnthropicRequestPayload({
      payload: original,
      ctx: context(),
      account: { deviceId: "device", accountUuid: "account" },
      headerRegistered: true,
      cacheRetention: undefined,
    });
    const serialized = JSON.stringify(rewritten);
    expect(serialized.match(/cache_control/g)).toHaveLength(1);
    expect(original.messages[0]?.content[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("rejects more than four cache breakpoints", () => {
    expect(() =>
      rewriteAnthropicRequestPayload({
        payload: {
          model: "claude-sonnet-4-5",
          max_tokens: 64_000,
          system: Array.from({ length: 5 }, (_unused, index) => ({
            type: "text",
            text: `system-${String(index)}`,
            cache_control: { type: "ephemeral" },
          })),
          messages: [{ role: "user", content: "hello" }],
        },
        ctx: context(),
        account: { deviceId: "device", accountUuid: "account" },
        headerRegistered: true,
        cacheRetention: undefined,
      }),
    ).toThrow(/at most 4/);
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

const messageStartUsage = {
  input_tokens: 1,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
};
const messageDeltaUsage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function rawSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseEvent(event: string, data: unknown): string {
  if (event === "message_start") {
    const payload = data as { message: Record<string, unknown> } & Record<string, unknown>;
    return rawSseEvent(event, {
      ...payload,
      message: {
        ...payload.message,
        usage: payload.message.usage ?? messageStartUsage,
      },
    });
  }
  if (event === "message_delta") {
    const payload = data as Record<string, unknown>;
    return rawSseEvent(event, { ...payload, usage: payload.usage ?? messageDeltaUsage });
  }
  return rawSseEvent(event, data);
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

function attributedPayload(payload: unknown): Record<string, unknown> {
  return rewriteAnthropicRequestPayload({
    payload,
    ctx: context(),
    account: TEST_ACCOUNT,
    headerRegistered: true,
    cacheRetention: undefined,
  }) as Record<string, unknown>;
}

function streamOptions(overrides: Partial<PiSimpleStreamOptions> = {}): PiSimpleStreamOptions {
  return {
    apiKey: "sk-ant-oat-test-token",
    cacheRetention: "none",
    sessionId: TEST_SESSION_ID,
    onPayload: attributedPayload,
    ...overrides,
  };
}

async function streamedResult(
  body: string,
  options: PiSimpleStreamOptions = streamOptions(),
): Promise<Awaited<ReturnType<ReturnType<typeof streamAnthropicViaBetaMessages>["result"]>>> {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
  return streamAnthropicViaBetaMessages(anthropicModel, userContext(), options).result();
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

  it("preserves the installed Anthropic refusal explanation", async () => {
    const result = await streamedResult(
      [
        sseEvent("message_start", { type: "message_start", message: { id: "msg-1" } }),
        sseEvent("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: "refusal",
            stop_details: { type: "refusal", explanation: "request refused by policy" },
          },
        }),
        sseEvent("message_stop", { type: "message_stop" }),
      ].join(""),
    );
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("request refused by policy");
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
        sseEvent("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
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

  it("requires host usage objects while accepting nullable no-cache fields", async () => {
    const nullableNoCacheUsage = [
      sseEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg-1",
          usage: {
            input_tokens: 11,
            output_tokens: 0,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null,
            cache_creation: null,
          },
        },
      }),
      sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: {
          input_tokens: null,
          output_tokens: 7,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      }),
      sseEvent("message_stop", { type: "message_stop" }),
    ].join("");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(nullableNoCacheUsage, { status: 200 })),
    );
    await expect(
      streamAnthropicViaBetaMessages(pricedAnthropicModel, userContext(), streamOptions()).result(),
    ).resolves.toMatchObject({
      stopReason: "stop",
      usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18 },
    });

    const missingUsageBodies = [
      [
        rawSseEvent("message_start", {
          type: "message_start",
          message: { id: "msg-1" },
        }),
        sseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
        }),
        sseEvent("message_stop", { type: "message_stop" }),
      ].join(""),
      [
        sseEvent("message_start", {
          type: "message_start",
          message: { id: "msg-1" },
        }),
        rawSseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
        }),
        sseEvent("message_stop", { type: "message_stop" }),
      ].join(""),
    ];
    for (const body of missingUsageBodies) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
      const result = await streamAnthropicViaBetaMessages(
        pricedAnthropicModel,
        userContext(),
        streamOptions(),
      ).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toMatch(/usage.*required/i);
    }
  });

  it("rejects malformed usage and cost tiers instead of ignoring them", async () => {
    const malformedUsage = [
      sseEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg-1",
          usage: { ...messageStartUsage, input_tokens: "1" },
        },
      }),
      sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
      }),
      sseEvent("message_stop", { type: "message_stop" }),
    ].join("");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(malformedUsage, { status: 200 })),
    );
    const usageResult = await streamAnthropicViaBetaMessages(
      pricedAnthropicModel,
      userContext(),
      streamOptions(),
    ).result();
    expect(usageResult.stopReason).toBe("error");
    expect(usageResult.errorMessage).toMatch(/input_tokens/);

    const malformedTierModel: PiModelLike = {
      ...pricedAnthropicModel,
      cost: {
        ...pricedAnthropicModel.cost,
        tiers: [
          {
            inputTokensAbove: "100" as never,
            input: 6,
            output: 30,
            cacheRead: 0.6,
            cacheWrite: 7.5,
          },
        ],
      },
    };
    const validUsage = malformedUsage.replace('"input_tokens":"1"', '"input_tokens":1');
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(validUsage, { status: 200 })));
    const tierResult = await streamAnthropicViaBetaMessages(
      malformedTierModel,
      userContext(),
      streamOptions(),
    ).result();
    expect(tierResult.stopReason).toBe("error");
    expect(tierResult.errorMessage).toMatch(/inputTokensAbove/);
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
      userContext(),
      streamOptions({ maxRetries: 1 }),
    ).result();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ stopReason: "stop", content: [{ text: "retried" }] });
  });

  it("obeys x-should-retry before status policy and cancels retried response bodies", async () => {
    const retryResponse = new Response("retry by directive", {
      status: 400,
      statusText: "Bad Request",
      headers: { "x-should-retry": "true", "retry-after-ms": "0" },
    });
    const cancel = vi.spyOn(retryResponse.body as ReadableStream<Uint8Array>, "cancel");
    const retryDirectiveFetch = vi
      .fn()
      .mockResolvedValueOnce(retryResponse)
      .mockResolvedValueOnce(new Response(successfulSse("directive retry"), { status: 200 }));
    const retried = await streamAnthropicViaBetaMessages(
      anthropicModel,
      userContext(),
      streamOptions({ fetch: retryDirectiveFetch, maxRetries: 1 }),
    ).result();
    expect(retryDirectiveFetch).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(retried).toMatchObject({ stopReason: "stop", content: [{ text: "directive retry" }] });

    const noRetryFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("do not retry", {
          status: 503,
          statusText: "Unavailable",
          headers: { "x-should-retry": "false" },
        }),
      )
      .mockResolvedValueOnce(new Response(successfulSse("wrong retry"), { status: 200 }));
    const rejected = await streamAnthropicViaBetaMessages(
      anthropicModel,
      userContext(),
      streamOptions({ fetch: noRetryFetch, maxRetries: 1 }),
    ).result();
    expect(noRetryFetch).toHaveBeenCalledTimes(1);
    expect(rejected.stopReason).toBe("error");
    expect(rejected.errorMessage).toMatch(/HTTP 503.*do not retry/);
  });

  it("honors maxRetryDelayMs and keeps custom fetch across retries", async () => {
    const globalFetch = vi.fn(() => {
      throw new Error("global fetch must not be used");
    });
    vi.stubGlobal("fetch", globalFetch);
    const cappedFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("busy", {
          status: 503,
          statusText: "Unavailable",
          headers: { "retry-after": "2" },
        }),
      )
      .mockResolvedValueOnce(new Response(successfulSse("must not retry"), { status: 200 }));
    const capped = await streamAnthropicViaBetaMessages(
      anthropicModel,
      userContext(),
      streamOptions({ fetch: cappedFetch, maxRetries: 1, maxRetryDelayMs: 100 }),
    ).result();
    expect(capped.stopReason).toBe("error");
    expect(capped.errorMessage).toMatch(/Server requested 2s retry delay.*max.*1s/i);
    expect(cappedFetch).toHaveBeenCalledTimes(1);

    const retryingFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("busy", {
          status: 503,
          statusText: "Unavailable",
          headers: { "retry-after-ms": "0" },
        }),
      )
      .mockResolvedValueOnce(new Response(successfulSse("custom retried"), { status: 200 }));
    const retried = await streamAnthropicViaBetaMessages(
      anthropicModel,
      userContext(),
      streamOptions({ fetch: retryingFetch, maxRetries: 1, maxRetryDelayMs: 100 }),
    ).result();
    expect(retried).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "custom retried" }],
    });
    expect(retryingFetch).toHaveBeenCalledTimes(2);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("exhausts retryable failures and never retries a non-retryable response", async () => {
    const retryable = vi
      .fn()
      .mockImplementation(
        async () => new Response("busy", { status: 503, statusText: "Unavailable" }),
      );
    vi.stubGlobal("fetch", retryable);
    const exhausted = await streamAnthropicViaBetaMessages(
      anthropicModel,
      userContext(),
      streamOptions({ maxRetries: 2 }),
    ).result();
    expect(retryable).toHaveBeenCalledTimes(3);
    expect(exhausted.stopReason).toBe("error");
    expect(exhausted.errorMessage).toMatch(/HTTP 503/);

    const nonRetryable = vi
      .fn()
      .mockResolvedValue(new Response("bad request", { status: 400, statusText: "Bad Request" }));
    vi.stubGlobal("fetch", nonRetryable);
    const rejected = await streamAnthropicViaBetaMessages(
      anthropicModel,
      userContext(),
      streamOptions({ maxRetries: 2 }),
    ).result();
    expect(nonRetryable).toHaveBeenCalledTimes(1);
    expect(rejected.stopReason).toBe("error");
    expect(rejected.errorMessage).toMatch(/HTTP 400/);
  });

  it("preserves the registered host endpoint, headers, null suppression, and fetch", async () => {
    const globalFetch = vi.fn(() => {
      throw new Error("global fetch must not be used");
    });
    vi.stubGlobal("fetch", globalFetch);
    const customFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        expect(String(input)).toBe("https://gateway.example.test/anthropic/v1/messages?beta=true");
        const headers = new Headers(init?.headers);
        expect(Object.fromEntries(headers.entries())).toMatchObject({
          accept: "application/vnd.pi+json",
          authorization: "Bearer sk-ant-oat-test-token",
          "content-type": "application/json",
          "user-agent": "pi-host-agent/0.84.2",
          "x-host-header": "host",
          "x-model-header": "model",
          "x-shared-header": "host",
        });
        expect(headers.has("x-removed-header")).toBe(false);
        return new Response(successfulSse("custom transport"), { status: 200 });
      },
    );
    const bus = new SynchronousBus();
    const registered = recordingHost(bus);
    createAnthropicAttributionExtension({
      loadAccount: () => ({ deviceId: "device", accountUuid: "account" }),
    })(registered.host);
    const provider = registered.providers[0] as ProviderConfig;
    const model: PiModelLike = {
      ...anthropicModel,
      baseUrl: "https://gateway.example.test/anthropic/",
      headers: {
        "X-Model-Header": "model",
        "X-Shared-Header": "model",
        "X-Removed-Header": "model",
      },
    };

    const result = await provider
      .streamSimple?.(
        model,
        userContext(),
        streamOptions({
          fetch: customFetch,
          headers: {
            Accept: "application/vnd.pi+json",
            Authorization: "Bearer sk-ant-oat-test-token",
            "User-Agent": "pi-host-agent/0.84.2",
            "X-Host-Header": "host",
            "X-Shared-Header": "host",
            "X-Removed-Header": null,
          },
        }),
      )
      .result();

    expect(result).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "custom transport" }],
    });
    expect(customFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("rejects missing routing and suppressed OAuth authorization before fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(successfulSse(), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    for (const baseUrl of [undefined, ""] as const) {
      const result = await streamAnthropicViaBetaMessages(
        { ...anthropicModel, baseUrl } as PiModelLike,
        userContext(),
        streamOptions(),
      ).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toMatch(/baseUrl.*required/i);
    }

    const missingAuthorization = await streamAnthropicViaBetaMessages(
      anthropicModel,
      userContext(),
      streamOptions({ headers: { Authorization: null } }),
    ).result();
    expect(missingAuthorization.stopReason).toBe("error");
    expect(missingAuthorization.errorMessage).toMatch(/Authorization.*required/i);
    expect(fetchMock).not.toHaveBeenCalled();
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
      userContext(),
      streamOptions({ timeoutMs: 5 }),
    ).result();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/timed out after 5 ms/);
  });

  it("revalidates attribution invariants after onPayload replacement", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(successfulSse(), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cases: Array<{
      readonly label: string;
      readonly replace: (payload: Record<string, unknown>) => Record<string, unknown>;
      readonly error: RegExp;
      readonly maxTokens?: number;
    }> = [
      {
        label: "changed caller maxTokens",
        maxTokens: 2048,
        replace: (payload) => ({ ...payload, max_tokens: 1024 }),
        error: /max_tokens.*2048/,
      },
      {
        label: "thinking budget at the output ceiling",
        replace: (payload) => ({
          ...payload,
          thinking: { type: "enabled", budget_tokens: payload.max_tokens },
        }),
        error: /thinking\.budget_tokens.*max_tokens/,
      },
      {
        label: "excess cache breakpoints",
        replace: (payload) => ({
          ...payload,
          system: Array.from({ length: 5 }, (_unused, index) => ({
            type: "text",
            text: `hook-system-${String(index)}`,
            cache_control: { type: "ephemeral" },
          })),
        }),
        error: /at most 4|system identity/,
      },
      {
        label: "unpaired surrogate",
        replace: (payload) => ({ ...payload, hook_text: String.fromCharCode(0xd800) }),
        error: /unpaired surrogate/i,
      },
      {
        label: "changed model",
        replace: (payload) => ({ ...payload, model: "claude-opus-5" }),
        error: /payload model.*claude-sonnet-4-5/,
      },
      {
        label: "changed account UUID",
        replace: (payload) => ({
          ...payload,
          metadata: {
            user_id: JSON.stringify({
              account_uuid: "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee",
              device_id: TEST_ACCOUNT.deviceId,
              session_id: TEST_SESSION_ID,
            }),
          },
        }),
        error: /account_uuid.*expected attribution/i,
      },
      {
        label: "changed device ID",
        replace: (payload) => ({
          ...payload,
          metadata: {
            user_id: JSON.stringify({
              account_uuid: TEST_ACCOUNT.accountUuid,
              device_id: "other-device",
              session_id: TEST_SESSION_ID,
            }),
          },
        }),
        error: /device_id.*expected attribution/i,
      },
      {
        label: "changed session ID",
        replace: (payload) => ({
          ...payload,
          metadata: {
            user_id: JSON.stringify({
              account_uuid: TEST_ACCOUNT.accountUuid,
              device_id: TEST_ACCOUNT.deviceId,
              session_id: "other-session",
            }),
          },
        }),
        error: /session_id.*expected attribution/i,
      },
      {
        label: "changed billing identity",
        replace: (payload) => ({
          ...payload,
          system: [
            { type: "text", text: "x-anthropic-billing-header: replaced" },
            ...((payload.system as Array<Record<string, unknown>>).slice(1) ?? []),
          ],
        }),
        error: /billing identity/i,
      },
      {
        label: "removed required system identity",
        replace: (payload) => ({
          ...payload,
          system: (payload.system as Array<Record<string, unknown>>).slice(0, 1),
        }),
        error: /system identity/i,
      },
    ];

    for (const testCase of cases) {
      const result = await streamAnthropicViaBetaMessages(
        anthropicModel,
        userContext(),
        streamOptions({
          maxTokens: testCase.maxTokens,
          onPayload: (payload) => testCase.replace(attributedPayload(payload)),
        }),
      ).result();
      expect(result.stopReason, testCase.label).toBe("error");
      expect(result.errorMessage, testCase.label).toMatch(testCase.error);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an onPayload result containing unsupported JSON before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await streamAnthropicViaBetaMessages(
      anthropicModel,
      userContext(),
      streamOptions({
        onPayload: (payload) => ({
          ...attributedPayload(payload),
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
        userContext(),
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
        session_id: TEST_SESSION_ID,
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
    expect(() => extension(second.host)).toThrow(/already claimed/i);

    expect(first.providers).toHaveLength(1);
    expect(first.handlers).toHaveLength(1);
    expect(second.providers).toHaveLength(0);
    expect(second.handlers).toHaveLength(0);
    expect(bus.listenerCount(ANTHROPIC_ATTRIBUTION_CLAIM_CHANNEL)).toBe(1);
    expect(Object.keys(first.host).sort()).toEqual(["events", "on", "registerProvider"]);
  });
});
