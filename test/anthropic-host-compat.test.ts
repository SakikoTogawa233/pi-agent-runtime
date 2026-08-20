import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  CacheRetention as HostCacheRetention,
  Model,
  SimpleStreamOptions,
  Tool,
} from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, Type } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  type AssistantMessageEventStreamLike,
  type AssistantMessageLike,
  buildAnthropicRequestParams,
  type CacheRetention,
  type PiModelLike,
  type PiSimpleStreamOptions,
  type PiStreamContext,
  type PiToolLike,
  streamAnthropicViaBetaMessages,
} from "../src/anthropic-attribution.js";

type Equal<Left, Right> = (<Type>() => Type extends Left ? 1 : 2) extends <
  Type,
>() => Type extends Right ? 1 : 2
  ? (<Type>() => Type extends Right ? 1 : 2) extends <Type>() => Type extends Left ? 1 : 2
    ? true
    : false
  : false;
type Expect<Type extends true> = Type;

type _ModelMatchesHost = Expect<Equal<PiModelLike, Model<"anthropic-messages">>>;
type _ContextMatchesHost = Expect<Equal<PiStreamContext, Context>>;
type _OptionsMatchHost = Expect<Equal<PiSimpleStreamOptions, SimpleStreamOptions>>;
type _ToolMatchesHost = Expect<Equal<PiToolLike, Tool>>;
type _MessageMatchesHost = Expect<Equal<AssistantMessageLike, AssistantMessage>>;
type _StreamMatchesHost = Expect<
  Equal<AssistantMessageEventStreamLike, AssistantMessageEventStream>
>;
type _CacheRetentionMatchesHost = Expect<Equal<CacheRetention, HostCacheRetention>>;
type _TransportMatchesProviderHost = Expect<
  Equal<typeof streamAnthropicViaBetaMessages, NonNullable<ProviderConfig["streamSimple"]>>
>;
const hostProviderTransport: NonNullable<ProviderConfig["streamSimple"]> =
  streamAnthropicViaBetaMessages;
void hostProviderTransport;

const catalogContext: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools: [
    {
      name: "read",
      description: "Read a file",
      parameters: Type.Object({}),
    },
  ],
};

const shortCacheOptions: SimpleStreamOptions = { cacheRetention: "short" };

describe("Pi 0.84.2 Anthropic host compatibility", () => {
  it("accepts representative installed catalog models with omitted compatibility booleans", () => {
    for (const model of Object.values(ANTHROPIC_MODELS)) {
      const params = buildAnthropicRequestParams(model, catalogContext, shortCacheOptions);
      expect(params.model).toBe(model.id);
      expect(params.max_tokens).toBe(model.maxTokens);
      expect(params.tools).toEqual([
        {
          name: "read",
          description: "Read a file",
          input_schema: { type: "object", properties: {} },
          cache_control: { type: "ephemeral" },
        },
      ]);
    }
  });

  it("honors explicit false capability overrides without requiring omitted host defaults", () => {
    const model: Model<"anthropic-messages"> = {
      ...ANTHROPIC_MODELS["claude-sonnet-4-5"],
      compat: {
        ...ANTHROPIC_MODELS["claude-sonnet-4-5"].compat,
        supportsCacheControlOnTools: false,
      },
    };
    const params = buildAnthropicRequestParams(model, catalogContext, shortCacheOptions);
    expect(params.tools).toEqual([
      {
        name: "read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });

  it("honors installed off and temperature capability semantics", () => {
    const fable = buildAnthropicRequestParams(ANTHROPIC_MODELS["claude-fable-5"], catalogContext, {
      cacheRetention: "none",
    });
    expect(fable).not.toHaveProperty("thinking");

    expect(() =>
      buildAnthropicRequestParams(ANTHROPIC_MODELS["claude-opus-4-7"], catalogContext, {
        cacheRetention: "none",
        temperature: 0.5,
      }),
    ).toThrow(/temperature.*not support/i);
    expect(
      buildAnthropicRequestParams(ANTHROPIC_MODELS["claude-sonnet-4-5"], catalogContext, {
        cacheRetention: "none",
        temperature: 0.5,
      }).temperature,
    ).toBe(0.5);
    expect(() =>
      buildAnthropicRequestParams(ANTHROPIC_MODELS["claude-sonnet-4-5"], catalogContext, {
        cacheRetention: "none",
        reasoning: "high",
        temperature: 0.5,
      }),
    ).toThrow(/temperature.*thinking/i);
  });

  it("maps every installed adaptive thinking level through the host model map", () => {
    for (const model of Object.values(ANTHROPIC_MODELS)) {
      if (model.compat?.forceAdaptiveThinking !== true) continue;
      for (const level of getSupportedThinkingLevels(model)) {
        if (level === "off") continue;
        const params = buildAnthropicRequestParams(model, catalogContext, {
          cacheRetention: "none",
          reasoning: level,
        });
        const mapped = model.thinkingLevelMap?.[level];
        const expected =
          typeof mapped === "string"
            ? mapped
            : level === "minimal" || level === "low"
              ? "low"
              : level === "medium"
                ? "medium"
                : "high";
        expect(params.output_config).toEqual({ effort: expected });
      }
    }
  });

  it("maps the installed max thinking level for adaptive and fixed-budget models", () => {
    const adaptive = buildAnthropicRequestParams(
      ANTHROPIC_MODELS["claude-opus-4-6"],
      catalogContext,
      { cacheRetention: "none", reasoning: "max", maxTokens: 4096 },
    );
    expect(adaptive.max_tokens).toBe(4096);
    expect(adaptive.thinking).toEqual({ type: "adaptive" });
    expect(adaptive.output_config).toEqual({ effort: "max" });

    const fixed = buildAnthropicRequestParams(
      ANTHROPIC_MODELS["claude-sonnet-4-5"],
      catalogContext,
      {
        cacheRetention: "none",
        reasoning: "max",
        thinkingBudgets: { high: 2048 },
        maxTokens: 4096,
      },
    );
    expect(fixed.max_tokens).toBe(4096);
    expect(fixed.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("honors caller maxTokens exactly and rejects hard model-cap violations", () => {
    const model = ANTHROPIC_MODELS["claude-sonnet-4-5"];
    expect(
      buildAnthropicRequestParams(model, catalogContext, {
        cacheRetention: "none",
        maxTokens: 2048,
      }).max_tokens,
    ).toBe(2048);
    expect(() =>
      buildAnthropicRequestParams(model, catalogContext, {
        cacheRetention: "none",
        maxTokens: model.maxTokens + 1,
      }),
    ).toThrow(/maxTokens.*model.maxTokens/);
    expect(() =>
      buildAnthropicRequestParams(model, catalogContext, {
        cacheRetention: "none",
        maxTokens: 0,
      }),
    ).toThrow(/maxTokens.*positive integer/);
  });
});
