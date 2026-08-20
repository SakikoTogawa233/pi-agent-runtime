import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_ATTRIBUTION_CLAIM_CHANNEL,
  createAnthropicAttributionExtension,
  rewriteAnthropicRequestPayload,
  type AnthropicAttributionExtensionHost,
  type AnthropicContextLike,
} from "../src/anthropic-attribution.js";

const badLines = [
  "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)",
  "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)",
  "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
] as const;

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
      this.handlers.set(channel, handlers.filter((candidate) => candidate !== handler));
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
  return {
    host: {
      events: bus,
      registerProvider: (_name, config) => providers.push(config),
      on: (_eventName, handler) => handlers.push(handler),
    },
    providers,
    handlers,
  };
}

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
    }) as Record<string, unknown>;
    expect(JSON.stringify(rewritten)).not.toContain(badLines[0]);
    expect(JSON.stringify(rewritten)).not.toContain(badLines[1]);
    expect(JSON.stringify(rewritten)).not.toContain(badLines[2]);
    expect(JSON.stringify(rewritten)).toContain("keep before\\nkeep after");
    expect(JSON.stringify(rewritten)).toContain("X-Claude-Code-Session-Id".slice(0, 0));
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
      rewriteAnthropicRequestPayload({ payload, ctx: context("openai-codex"), account: { deviceId: "d", accountUuid: "a" } }),
    ).toBeUndefined();
    expect(() =>
      rewriteAnthropicRequestPayload({ payload: [], ctx: context(), account: { deviceId: "d", accountUuid: "a" } }),
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
