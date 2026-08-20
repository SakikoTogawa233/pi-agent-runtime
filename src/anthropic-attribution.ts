import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  FetchFunction,
  CacheRetention as HostCacheRetention,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, hasApi } from "@earendil-works/pi-ai";
import {
  getJsonSchemaToolParameters,
  resolveJsonSchemaStrictSampling,
} from "@earendil-works/pi-ai/api/constrained-sampling";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { assertJsonValue } from "./json-value.js";

export const CLAUDE_CODE_SESSION_HEADER = "X-Claude-Code-Session-Id";

const CLAUDE_CODE_VERSION = "2.1.173";
const CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.173 (external, sdk-cli)";
export const ANTHROPIC_1M_CONTEXT_BETA = "context-1m-2025-08-07" as const;
export const CLAUDE_CODE_200K_SUBSCRIPTION_CONTEXT_WINDOW = 200_000 as const;

type ClaudeCode200KSubscriptionBetaValue =
  | "claude-code-20250219"
  | "oauth-2025-04-20"
  | "interleaved-thinking-2025-05-14"
  | "thinking-token-count-2026-05-13"
  | "context-management-2025-06-27"
  | "prompt-caching-scope-2026-01-05"
  | "advisor-tool-2026-03-01"
  | "structured-outputs-2025-12-15"
  | "mid-conversation-system-2026-04-07";

const CLAUDE_CODE_LEGACY_BETA_VALUES = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "advisor-tool-2026-03-01",
  "structured-outputs-2025-12-15",
] as const satisfies readonly ClaudeCode200KSubscriptionBetaValue[];
const CLAUDE_CODE_ADAPTIVE_200K_BETA_VALUES = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
] as const satisfies readonly ClaudeCode200KSubscriptionBetaValue[];

function build200KSubscriptionBetaHeader(
  values: readonly ClaudeCode200KSubscriptionBetaValue[],
): string {
  if ((values as readonly string[]).includes(ANTHROPIC_1M_CONTEXT_BETA)) {
    throw new Error(
      `Anthropic attribution 200K subscription policy must not emit ${ANTHROPIC_1M_CONTEXT_BETA}`,
    );
  }
  return values.join(",");
}

export const CLAUDE_CODE_BETA = build200KSubscriptionBetaHeader(CLAUDE_CODE_LEGACY_BETA_VALUES);
const CLAUDE_CODE_ADAPTIVE_200K_BETA = build200KSubscriptionBetaHeader(
  CLAUDE_CODE_ADAPTIVE_200K_BETA_VALUES,
);
const CLAUDE_AGENT_SDK_SYSTEM_TEXT =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const FINGERPRINT_SALT = "59cf53e54c78";
const AUDIT_ENV = "PIPELINE_ANTHROPIC_ATTRIBUTION_AUDIT_PATH";
const CACHE_RETENTION_ENV = "PI_CACHE_RETENTION";
export const ANTHROPIC_ATTRIBUTION_CLAIM_CHANNEL =
  "pi-agent-runtime:anthropic-attribution:claim:v1";
const ANTHROPIC_ATTRIBUTION_CLAIM_SCHEMA = "pi-agent-runtime.anthropic-attribution.claim.v1";
const NATIVE_ATTESTATION_PLACEHOLDER = "00000";
const ANTHROPIC_CACHE_CONTROL_BREAKPOINT_LIMIT = 4;
const ANTHROPIC_ATTRIBUTION_PROOF_KEY = "__pi_agent_runtime_anthropic_attribution_v1";
const ANTHROPIC_ATTRIBUTION_PROOF_SECRET = randomBytes(32);

interface ExpectedAnthropicAttribution {
  readonly accountUuid: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly billingSystemText: string;
  readonly identityBlocks: readonly [JsonObject, JsonObject];
}

function encodeAnthropicAttributionProof(expected: ExpectedAnthropicAttribution): string {
  const payload = Buffer.from(JSON.stringify(expected), "utf8").toString("base64url");
  const signature = createHmac("sha256", ANTHROPIC_ATTRIBUTION_PROOF_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function decodeAnthropicAttributionProof(value: unknown): ExpectedAnthropicAttribution {
  if (typeof value !== "string") {
    throw new Error("Anthropic attribution payload is missing expected attribution proof");
  }
  const separator = value.indexOf(".");
  if (separator <= 0 || separator !== value.lastIndexOf(".")) {
    throw new Error("Anthropic attribution payload contains malformed attribution proof");
  }
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expectedSignature = createHmac("sha256", ANTHROPIC_ATTRIBUTION_PROOF_SECRET)
    .update(payload)
    .digest();
  const actualSignature = Buffer.from(signature, "base64url");
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new Error("Anthropic attribution payload contains invalid attribution proof");
  }
  const decoded = parseJsonObject(
    Buffer.from(payload, "base64url").toString("utf8"),
    "Anthropic attribution proof",
  );
  const identityBlocks = decoded["identityBlocks"];
  if (
    typeof decoded["accountUuid"] !== "string" ||
    typeof decoded["deviceId"] !== "string" ||
    typeof decoded["sessionId"] !== "string" ||
    typeof decoded["billingSystemText"] !== "string" ||
    !Array.isArray(identityBlocks) ||
    identityBlocks.length !== 2 ||
    !isPlainObject(identityBlocks[0]) ||
    !isPlainObject(identityBlocks[1])
  ) {
    throw new Error("Anthropic attribution proof identity is malformed");
  }
  return {
    accountUuid: decoded["accountUuid"],
    deviceId: decoded["deviceId"],
    sessionId: decoded["sessionId"],
    billingSystemText: decoded["billingSystemText"],
    identityBlocks: [identityBlocks[0], identityBlocks[1]],
  };
}

// Sanitization behavior derived from the MIT-licensed ravshansbox/pi-anthropic-sps
// extension at commit 17409b5615f0ec0625776bc5434f92f2c55e3fd0. Keep exact-match
// semantics and all known Pi prompt variants; unrelated system text is preserved.
const ANTHROPIC_SYSTEM_PROMPT_BAD_LINES = new Set([
  "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)",
  "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)",
  "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
]);

type JsonObject = Record<string, unknown>;
export type CacheRetention = HostCacheRetention;
type ProviderEnv = NonNullable<SimpleStreamOptions["env"]>;
export interface AnthropicCacheControl {
  type: "ephemeral";
  ttl?: "1h" | "5m";
  [key: string]: unknown;
}

const parseJsonSource = JSON.parse.bind(JSON) as (source: string) => unknown;

function parseJsonValue(text: string, label: string): unknown {
  try {
    return parseJsonSource(text);
  } catch (error) {
    throw new Error(
      `${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseJsonObject(text: string, label: string): JsonObject {
  const parsed = parseJsonValue(text, label);
  if (!isPlainObject(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

export interface ClaudeAttributionAccount {
  readonly deviceId: string;
  readonly accountUuid: string;
}

type PiCostRatesLike = Model<"anthropic-messages">["cost"];

export type PiModelLike = Model<"anthropic-messages">;

type ClaudeCodeThinkingPolicy = "fixed-budget" | "adaptive-effort";

export interface ClaudeCodeModelPolicy {
  readonly modelId: string;
  readonly beta: string;
  readonly thinkingPolicy: ClaudeCodeThinkingPolicy;
  readonly contextWindow: typeof CLAUDE_CODE_200K_SUBSCRIPTION_CONTEXT_WINDOW;
}

function claudeCode200KSubscriptionPolicy(
  modelId: string,
  beta: string,
  thinkingPolicy: ClaudeCodeThinkingPolicy,
): ClaudeCodeModelPolicy {
  if (beta.split(",").includes(ANTHROPIC_1M_CONTEXT_BETA)) {
    throw new Error(
      `Anthropic attribution 200K subscription policy for ${modelId} must not emit ${ANTHROPIC_1M_CONTEXT_BETA}`,
    );
  }
  return {
    modelId,
    beta,
    thinkingPolicy,
    contextWindow: CLAUDE_CODE_200K_SUBSCRIPTION_CONTEXT_WINDOW,
  };
}

const CLAUDE_CODE_MODEL_POLICIES: Record<string, ClaudeCodeModelPolicy> = Object.freeze({
  "claude-3-5-haiku-20241022": claudeCode200KSubscriptionPolicy(
    "claude-3-5-haiku-20241022",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-3-5-haiku-latest": claudeCode200KSubscriptionPolicy(
    "claude-3-5-haiku-latest",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-3-5-sonnet-20240620": claudeCode200KSubscriptionPolicy(
    "claude-3-5-sonnet-20240620",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-3-5-sonnet-20241022": claudeCode200KSubscriptionPolicy(
    "claude-3-5-sonnet-20241022",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-3-7-sonnet-20250219": claudeCode200KSubscriptionPolicy(
    "claude-3-7-sonnet-20250219",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-3-haiku-20240307": claudeCode200KSubscriptionPolicy(
    "claude-3-haiku-20240307",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-3-opus-20240229": claudeCode200KSubscriptionPolicy(
    "claude-3-opus-20240229",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-3-sonnet-20240229": claudeCode200KSubscriptionPolicy(
    "claude-3-sonnet-20240229",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-fable-5": claudeCode200KSubscriptionPolicy(
    "claude-fable-5",
    CLAUDE_CODE_ADAPTIVE_200K_BETA,
    "adaptive-effort",
  ),
  "claude-haiku-4-5": claudeCode200KSubscriptionPolicy(
    "claude-haiku-4-5",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-haiku-4-5-20251001": claudeCode200KSubscriptionPolicy(
    "claude-haiku-4-5-20251001",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-opus-4-0": claudeCode200KSubscriptionPolicy(
    "claude-opus-4-0",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-opus-4-1": claudeCode200KSubscriptionPolicy(
    "claude-opus-4-1",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-opus-4-1-20250805": claudeCode200KSubscriptionPolicy(
    "claude-opus-4-1-20250805",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-opus-4-20250514": claudeCode200KSubscriptionPolicy(
    "claude-opus-4-20250514",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-opus-4-5": claudeCode200KSubscriptionPolicy(
    "claude-opus-4-5",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-opus-4-5-20251101": claudeCode200KSubscriptionPolicy(
    "claude-opus-4-5-20251101",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-opus-4-6": claudeCode200KSubscriptionPolicy(
    "claude-opus-4-6",
    CLAUDE_CODE_ADAPTIVE_200K_BETA,
    "adaptive-effort",
  ),
  "claude-opus-4-7": claudeCode200KSubscriptionPolicy(
    "claude-opus-4-7",
    CLAUDE_CODE_ADAPTIVE_200K_BETA,
    "adaptive-effort",
  ),
  "claude-opus-4-8": claudeCode200KSubscriptionPolicy(
    "claude-opus-4-8",
    CLAUDE_CODE_ADAPTIVE_200K_BETA,
    "adaptive-effort",
  ),
  "claude-opus-5": claudeCode200KSubscriptionPolicy(
    "claude-opus-5",
    CLAUDE_CODE_ADAPTIVE_200K_BETA,
    "adaptive-effort",
  ),
  "claude-sonnet-4-0": claudeCode200KSubscriptionPolicy(
    "claude-sonnet-4-0",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-sonnet-4-20250514": claudeCode200KSubscriptionPolicy(
    "claude-sonnet-4-20250514",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-sonnet-4-5": claudeCode200KSubscriptionPolicy(
    "claude-sonnet-4-5",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-sonnet-4-5-20250929": claudeCode200KSubscriptionPolicy(
    "claude-sonnet-4-5-20250929",
    CLAUDE_CODE_BETA,
    "fixed-budget",
  ),
  "claude-sonnet-4-6": claudeCode200KSubscriptionPolicy(
    "claude-sonnet-4-6",
    CLAUDE_CODE_ADAPTIVE_200K_BETA,
    "adaptive-effort",
  ),
  "claude-sonnet-5": claudeCode200KSubscriptionPolicy(
    "claude-sonnet-5",
    CLAUDE_CODE_ADAPTIVE_200K_BETA,
    "adaptive-effort",
  ),
});

export type AnthropicContextLike = Pick<ExtensionContext, "model" | "sessionManager">;
export type AnthropicAttributionExtensionHost = ExtensionAPI;
type HostStreamSimple = NonNullable<ProviderConfig["streamSimple"]>;

export type PiStreamContext = Context;
export type PiToolLike = Tool;
export type PiSimpleStreamOptions = SimpleStreamOptions;
export type AssistantMessageLike = AssistantMessage;
export type AssistantMessageEventStreamLike = AssistantMessageEventStream;

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function providerEnvValue(name: string, env?: ProviderEnv): string | undefined {
  return env?.[name] ?? process.env[name];
}

function parseCacheRetention(value: unknown, source: string): CacheRetention {
  if (value === "none" || value === "short" || value === "long") return value;
  throw new Error(
    `Anthropic attribution ${source} must be one of none, short, or long; got ${JSON.stringify(value)}`,
  );
}

/**
 * Resolve retention without allowing the extension default to override an
 * explicit call-level posture (notably Pi's cacheRetention=none compaction calls).
 * Precedence: request option -> persisted session override -> process/provider env.
 * If all are absent, the caller has not supplied policy and the runtime rejects.
 */
export function resolveCacheRetentionPreference(
  options?: {
    readonly cacheRetention?: CacheRetention;
    readonly env?: ProviderEnv;
  },
  sessionOverride?: Exclude<CacheRetention, "none">,
): CacheRetention {
  if (options?.cacheRetention !== undefined)
    return parseCacheRetention(options.cacheRetention, "cacheRetention");
  if (sessionOverride !== undefined)
    return parseCacheRetention(sessionOverride, "session override");
  const configured = providerEnvValue(CACHE_RETENTION_ENV, options?.env);
  if (configured !== undefined) return parseCacheRetention(configured, CACHE_RETENTION_ENV);
  throw new Error("Anthropic attribution cache retention policy is required");
}

function anthropicCompatibility(model: PiModelLike): {
  supportsLongCacheRetention: boolean | undefined;
  supportsCacheControlOnTools: boolean | undefined;
  supportsTemperature: boolean | undefined;
  supportsStrictTools: boolean;
  allowEmptySignature: boolean;
} {
  const compat: unknown = model.compat;
  if (compat === undefined) {
    return {
      supportsLongCacheRetention: undefined,
      supportsCacheControlOnTools: undefined,
      supportsTemperature: undefined,
      supportsStrictTools: false,
      allowEmptySignature: false,
    };
  }
  if (!isPlainObject(compat)) throw new Error("Anthropic model compat must be an object");
  const supportsLongCacheRetention = compat["supportsLongCacheRetention"];
  const supportsCacheControlOnTools = compat["supportsCacheControlOnTools"];
  const supportsTemperature = compat["supportsTemperature"];
  const supportsStrictTools = compat["supportsStrictTools"];
  const allowEmptySignature = compat["allowEmptySignature"];
  if (supportsLongCacheRetention !== undefined && typeof supportsLongCacheRetention !== "boolean") {
    throw new Error("Anthropic model compat.supportsLongCacheRetention must be boolean");
  }
  if (
    supportsCacheControlOnTools !== undefined &&
    typeof supportsCacheControlOnTools !== "boolean"
  ) {
    throw new Error("Anthropic model compat.supportsCacheControlOnTools must be boolean");
  }
  if (supportsTemperature !== undefined && typeof supportsTemperature !== "boolean") {
    throw new Error("Anthropic model compat.supportsTemperature must be boolean");
  }
  if (supportsStrictTools !== undefined && typeof supportsStrictTools !== "boolean") {
    throw new Error("Anthropic model compat.supportsStrictTools must be boolean");
  }
  if (allowEmptySignature !== undefined && typeof allowEmptySignature !== "boolean") {
    throw new Error("Anthropic model compat.allowEmptySignature must be boolean");
  }
  return {
    supportsLongCacheRetention,
    supportsCacheControlOnTools,
    supportsTemperature,
    supportsStrictTools: supportsStrictTools ?? false,
    allowEmptySignature: allowEmptySignature ?? false,
  };
}

function resolveAnthropicCacheControl(
  model: PiModelLike,
  options?: { readonly cacheRetention?: CacheRetention; readonly env?: ProviderEnv },
): AnthropicCacheControl | undefined {
  const retention = resolveCacheRetentionPreference(options);
  if (retention === "none") return undefined;
  const supportsLongCacheRetention = anthropicCompatibility(model).supportsLongCacheRetention;
  if (retention === "long" && supportsLongCacheRetention === false) {
    throw new Error("Anthropic model does not support requested long cache retention");
  }
  const ttl = retention === "long" ? "1h" : undefined;
  return ttl === undefined ? { type: "ephemeral" } : { type: "ephemeral", ttl };
}

function cloneAnthropicCacheControl(value: unknown): AnthropicCacheControl | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(
      "Anthropic attribution cannot safely process malformed cache_control; expected an object",
    );
  }
  if (value["type"] !== "ephemeral") {
    throw new Error(
      'Anthropic attribution cannot safely process malformed cache_control.type; expected "ephemeral"',
    );
  }
  const ttl = value["ttl"];
  if (ttl !== undefined && ttl !== "1h" && ttl !== "5m") {
    throw new Error(
      'Anthropic attribution cannot safely process malformed cache_control.ttl; expected "1h" or "5m"',
    );
  }
  return {
    ...value,
    type: "ephemeral",
    ...(ttl === undefined ? {} : { ttl }),
  } as AnthropicCacheControl;
}

function mergedCacheControl(
  existing: unknown,
  desired: AnthropicCacheControl | undefined,
): AnthropicCacheControl | undefined {
  const existingControl = cloneAnthropicCacheControl(existing);
  if (existingControl === undefined) return desired === undefined ? undefined : { ...desired };
  if (desired?.ttl === "1h" && existingControl.ttl !== "1h")
    return { ...existingControl, ttl: "1h" };
  return existingControl;
}

function cloneBlockWithCacheControl(
  block: JsonObject,
  desired: AnthropicCacheControl | undefined,
): JsonObject {
  const next = { ...block };
  const cacheControl = mergedCacheControl(next["cache_control"], desired);
  if (cacheControl !== undefined) next["cache_control"] = cacheControl;
  return next;
}

function stripAnthropicSystemPromptBadLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !ANTHROPIC_SYSTEM_PROMPT_BAD_LINES.has(line))
    .join("\n");
}

function inspectCacheControls(payload: JsonObject): number {
  let count = 0;
  const inspectBlock = (block: unknown): void => {
    if (!isPlainObject(block) || block["cache_control"] === undefined) return;
    cloneAnthropicCacheControl(block["cache_control"]);
    count += 1;
  };

  const system = payload["system"];
  if (Array.isArray(system)) {
    for (const block of system) inspectBlock(block);
  }

  const tools = payload["tools"];
  if (Array.isArray(tools)) {
    for (const tool of tools) inspectBlock(tool);
  }

  const messages = payload["messages"];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isPlainObject(message)) continue;
      const content = message["content"];
      if (Array.isArray(content)) {
        for (const block of content) inspectBlock(block);
      }
    }
  }

  return count;
}

function countCacheControlBreakpoints(payload: JsonObject): number {
  return inspectCacheControls(payload);
}

function assertCacheControlBreakpointLimit(payload: JsonObject): void {
  const count = countCacheControlBreakpoints(payload);
  if (count > ANTHROPIC_CACHE_CONTROL_BREAKPOINT_LIMIT) {
    throw new Error(
      `Anthropic attribution produced ${count} cache_control breakpoints; Anthropic supports at most ${ANTHROPIC_CACHE_CONTROL_BREAKPOINT_LIMIT}`,
    );
  }
}

function assertNonEmptyString(value: unknown, fieldName: string, configPath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Anthropic attribution config ${configPath} missing/malformed required field ${fieldName}`,
    );
  }
  return value;
}

export function extractClaudeAttributionAccount(
  parsedConfig: unknown,
  configPath: string,
): ClaudeAttributionAccount {
  if (!isPlainObject(parsedConfig)) {
    throw new Error(`Anthropic attribution config ${configPath} is not a JSON object`);
  }
  const oauthAccount = parsedConfig["oauthAccount"];
  if (!isPlainObject(oauthAccount)) {
    throw new Error(
      `Anthropic attribution config ${configPath} missing/malformed required field oauthAccount.accountUuid`,
    );
  }
  return {
    deviceId: assertNonEmptyString(parsedConfig["userID"], "userID", configPath),
    accountUuid: assertNonEmptyString(
      oauthAccount["accountUuid"],
      "oauthAccount.accountUuid",
      configPath,
    ),
  };
}

export function loadClaudeAttributionAccount(
  configPath = join(homedir(), ".claude.json"),
): ClaudeAttributionAccount {
  let configText: string;
  try {
    configText = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new Error(
      `Anthropic attribution config ${configPath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return extractClaudeAttributionAccount(
    parseJsonValue(configText, `Anthropic attribution config ${configPath}`),
    configPath,
  );
}

export function isAnthropicContext(ctx: AnthropicContextLike): boolean {
  return ctx.model?.provider === "anthropic";
}

function requireAnthropicModel(model: Model<Api> | undefined): PiModelLike {
  if (model === undefined) throw new Error("Anthropic attribution requires an active model");
  if (model.provider !== "anthropic") {
    throw new Error(
      `Anthropic attribution only accepts the anthropic provider; got ${String(model.provider)}`,
    );
  }
  if (!hasApi(model, "anthropic-messages")) {
    throw new Error(
      `Anthropic attribution requires api anthropic-messages; got ${String(model.api)}`,
    );
  }
  return model;
}

function getSessionId(ctx: AnthropicContextLike): string {
  const sessionId = ctx.sessionManager.getSessionId();
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new Error("Anthropic attribution requires a non-empty Pi session id");
  }
  return sessionId;
}

function normalizedAnthropicModelId(model: PiModelLike): string {
  if (typeof model.id !== "string" || model.id.trim().length === 0) {
    throw new Error("Anthropic attribution requires a non-empty model id");
  }
  const providerPrefix = "anthropic/";
  return model.id.startsWith(providerPrefix) ? model.id.slice(providerPrefix.length) : model.id;
}

export function resolveClaudeCodeModelPolicy(model: PiModelLike): ClaudeCodeModelPolicy {
  const modelId = normalizedAnthropicModelId(model);
  const policy = CLAUDE_CODE_MODEL_POLICIES[modelId];
  if (policy === undefined) {
    throw new Error(`Anthropic attribution has no Claude Code model policy for ${modelId}`);
  }
  return policy;
}

export function resolveAnthropicMaxTokens(model: PiModelLike): number {
  return assertPositiveInteger(
    model.maxTokens,
    `model.maxTokens for ${normalizedAnthropicModelId(model)}`,
  );
}

export function computeClaudeCodeFingerprint(
  messageText: string,
  version = CLAUDE_CODE_VERSION,
): string {
  const chars = [4, 7, 20].map((index) => messageText[index] || "0").join("");
  return createHash("sha256")
    .update(`${FINGERPRINT_SALT}${chars}${version}`)
    .digest("hex")
    .slice(0, 3);
}

function firstUserMessageTextFromPayload(payload: JsonObject): string {
  const messages = payload["messages"];
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Anthropic attribution requires a first user text message");
  }
  for (const [messageIndex, message] of messages.entries()) {
    if (!isPlainObject(message)) {
      throw new Error(`Anthropic attribution payload message ${String(messageIndex)} is malformed`);
    }
    if (message["role"] !== "user") continue;
    const content = message["content"];
    if (typeof content === "string") {
      return nonEmptyString(content, "first user text");
    }
    if (!Array.isArray(content)) {
      throw new Error("Anthropic attribution first user content must contain text");
    }
    for (const [blockIndex, block] of content.entries()) {
      if (!isPlainObject(block)) {
        throw new Error(
          `Anthropic attribution first user content block ${String(blockIndex)} is malformed`,
        );
      }
      if (block["type"] === "text") {
        return nonEmptyString(block["text"], "first user text");
      }
    }
    throw new Error("Anthropic attribution requires a first user text message");
  }
  throw new Error("Anthropic attribution requires a first user text message");
}

export function buildClaudeCodeBillingSystemText(firstUserMessageText: string): string {
  const fingerprint = computeClaudeCodeFingerprint(firstUserMessageText);
  return `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${fingerprint}; cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT}; cch=${NATIVE_ATTESTATION_PLACEHOLDER};`;
}

export function buildAnthropicAttributionHeaders(
  sessionId: string,
  model: PiModelLike,
): Record<string, string> {
  const beta = resolveClaudeCodeModelPolicy(model).beta;
  return {
    [CLAUDE_CODE_SESSION_HEADER]: sessionId,
    "anthropic-beta": beta,
    "anthropic-version": "2023-06-01",
    "User-Agent": CLAUDE_CODE_USER_AGENT,
    "x-app": "cli",
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

export function registerAnthropicAttributionProvider(
  pi: ExtensionAPI,
  ctx: AnthropicContextLike,
  getSessionOverride: () => Exclude<CacheRetention, "none"> | undefined,
): void {
  if (!isAnthropicContext(ctx)) return;
  const activeModel = requireAnthropicModel(ctx.model);
  const streamSimple: HostStreamSimple = (model, context, options) =>
    streamAnthropicViaBetaMessages(requireAnthropicModel(model), context, {
      ...options,
      cacheRetention: resolveCacheRetentionPreference(options, getSessionOverride()),
    });
  pi.registerProvider("anthropic", {
    api: "anthropic-messages",
    headers: buildAnthropicAttributionHeaders(getSessionId(ctx), activeModel),
    streamSimple,
  });
}

function assertPositiveInteger(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error(
      `Anthropic attribution cannot safely process malformed ${fieldName}; expected a positive integer`,
    );
  }
  return value;
}

function rewriteThinking(
  payload: JsonObject,
  maxTokens: number | undefined,
): { readonly thinking: unknown; readonly budgetTokens: number | undefined } {
  if (payload["thinking"] === undefined) return { thinking: undefined, budgetTokens: undefined };
  if (!isPlainObject(payload["thinking"])) {
    throw new Error(
      "Anthropic attribution cannot safely process malformed thinking; expected an object",
    );
  }
  const thinking = { ...payload["thinking"] };
  if (thinking["type"] === "disabled")
    return { thinking: { type: "disabled" }, budgetTokens: undefined };
  if (thinking["budget_tokens"] === undefined) return { thinking, budgetTokens: undefined };
  const existingBudget = assertPositiveInteger(thinking["budget_tokens"], "thinking.budget_tokens");
  if (maxTokens !== undefined && existingBudget >= maxTokens) {
    throw new Error("Anthropic attribution requires thinking.budget_tokens < max_tokens");
  }
  return { thinking, budgetTokens: thinking["budget_tokens"] as number };
}

function isClaudeCodeIdentityText(text: string): boolean {
  return (
    text.startsWith("x-anthropic-billing-header:") ||
    text === CLAUDE_AGENT_SDK_SYSTEM_TEXT ||
    text === "You are Claude Code, Anthropic's official CLI for Claude." ||
    text ===
      "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
  );
}

function normalizeSystemBlock(block: unknown): JsonObject {
  if (!isPlainObject(block) || block["type"] !== "text" || typeof block["text"] !== "string") {
    throw new Error("Anthropic attribution system block must be a text object");
  }
  const next = { ...block };
  next["text"] = stripAnthropicSystemPromptBadLines(next["text"] as string);
  if (next["cache_control"] !== undefined)
    next["cache_control"] = cloneAnthropicCacheControl(next["cache_control"]);
  return next;
}

function hasCacheControl(block: unknown): block is JsonObject {
  return isPlainObject(block) && block["cache_control"] !== undefined;
}

function isSystemCacheSurface(block: unknown): block is JsonObject {
  return isPlainObject(block) && typeof block["text"] === "string";
}

function markSystemCacheSurface(
  blocks: readonly unknown[],
  desired: AnthropicCacheControl | undefined,
): unknown[] {
  const output = blocks.map((block) => (isPlainObject(block) ? { ...block } : block));
  if (desired === undefined) return output;

  let lastTextBlockIndex = -1;
  for (let index = 0; index < output.length; index += 1) {
    if (isSystemCacheSurface(output[index])) lastTextBlockIndex = index;
  }

  if (lastTextBlockIndex === -1) return output;

  const withLongRetentionUpgrades =
    desired.ttl === "1h"
      ? output.map((block) =>
          hasCacheControl(block) ? cloneBlockWithCacheControl(block, desired) : block,
        )
      : output;
  withLongRetentionUpgrades[lastTextBlockIndex] = cloneBlockWithCacheControl(
    withLongRetentionUpgrades[lastTextBlockIndex] as JsonObject,
    desired,
  );
  return withLongRetentionUpgrades;
}

function withClaudeCodeSystemIdentity(
  system: unknown,
  billingSystemText: string,
  cacheControl: AnthropicCacheControl | undefined,
): unknown {
  const identityBlocks: JsonObject[] = [
    { type: "text", text: billingSystemText },
    { type: "text", text: CLAUDE_AGENT_SDK_SYSTEM_TEXT },
  ];
  if (system === undefined) return markSystemCacheSurface(identityBlocks, cacheControl);
  if (Array.isArray(system)) {
    const withoutPriorIdentity = system
      .filter((entry) => {
        if (!isPlainObject(entry) || typeof entry["text"] !== "string") return true;
        return !isClaudeCodeIdentityText(entry["text"]);
      })
      .map(normalizeSystemBlock);
    return markSystemCacheSurface([...identityBlocks, ...withoutPriorIdentity], cacheControl);
  }
  if (typeof system === "string") {
    return markSystemCacheSurface(
      [...identityBlocks, { type: "text", text: stripAnthropicSystemPromptBadLines(system) }],
      cacheControl,
    );
  }
  throw new Error(
    "Anthropic attribution cannot safely apply Claude Code system identity to malformed system payload",
  );
}

function appendAuditRecord(args: {
  readonly provider: "anthropic";
  readonly headerRegistered: boolean;
  readonly metadataSessionMatchesHeader: boolean;
  readonly maxTokens: number | undefined;
  readonly thinkingBudgetTokens: number | undefined;
  readonly beta: string;
  readonly betaResourcePath: string;
  readonly nativeAttestation: "placeholder-pending-live";
}): void {
  const auditPath = process.env[AUDIT_ENV];
  if (auditPath === undefined || auditPath.length === 0) return;
  const record = {
    schema_version: "pipeline.anthropic_attribution_audit.v1",
    provider: args.provider,
    header_name: CLAUDE_CODE_SESSION_HEADER,
    header_registered: args.headerRegistered,
    anthropic_beta: args.beta,
    anthropic_version: "2023-06-01",
    beta_resource_path: args.betaResourcePath,
    native_attestation: args.nativeAttestation,
    metadata_user_id_keys: ["account_uuid", "device_id", "session_id"],
    metadata_session_id_matches_header: args.metadataSessionMatchesHeader,
    account_uuid_present: true,
    device_id_present: true,
    max_tokens: args.maxTokens,
    thinking_budget_tokens: args.thinkingBudgetTokens,
  };
  appendFileSync(auditPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function rewriteAnthropicRequestPayload(args: {
  readonly payload: unknown;
  readonly ctx: AnthropicContextLike;
  readonly account: ClaudeAttributionAccount;
  readonly headerRegistered: boolean;
  readonly cacheRetention: CacheRetention | undefined;
}): unknown {
  if (!isAnthropicContext(args.ctx)) return undefined;
  if (!isPlainObject(args.payload)) {
    throw new Error("Anthropic attribution expected provider payload to be a JSON object");
  }

  const sessionId = getSessionId(args.ctx);
  const metadata = args.payload["metadata"] === undefined ? {} : args.payload["metadata"];
  if (!isPlainObject(metadata)) {
    throw new Error("Anthropic attribution expected payload.metadata to be an object when present");
  }

  const model = requireAnthropicModel(args.ctx.model);
  const policy = resolveClaudeCodeModelPolicy(model);
  const maxTokens =
    args.payload["max_tokens"] === undefined
      ? undefined
      : assertPositiveInteger(args.payload["max_tokens"], "max_tokens");
  const { thinking, budgetTokens } = rewriteThinking(args.payload, maxTokens);
  const billingSystemText = buildClaudeCodeBillingSystemText(
    firstUserMessageTextFromPayload(args.payload),
  );
  const cacheControl =
    args.cacheRetention === undefined
      ? undefined
      : resolveAnthropicCacheControl(model, {
          cacheRetention: args.cacheRetention,
        });

  const rewrittenSystem = withClaudeCodeSystemIdentity(
    args.payload["system"],
    billingSystemText,
    cacheControl,
  );
  if (!Array.isArray(rewrittenSystem)) {
    throw new Error("Anthropic attribution system identity must be an array");
  }
  const firstIdentityBlock = rewrittenSystem[0];
  const secondIdentityBlock = rewrittenSystem[1];
  if (!isPlainObject(firstIdentityBlock) || !isPlainObject(secondIdentityBlock)) {
    throw new Error("Anthropic attribution required system identity blocks are malformed");
  }
  const rewritten: JsonObject = {
    ...args.payload,
    metadata: {
      ...metadata,
      user_id: JSON.stringify({
        account_uuid: args.account.accountUuid,
        device_id: args.account.deviceId,
        session_id: sessionId,
      }),
    },
    system: rewrittenSystem,
  };
  rewritten[ANTHROPIC_ATTRIBUTION_PROOF_KEY] = encodeAnthropicAttributionProof({
    accountUuid: args.account.accountUuid,
    deviceId: args.account.deviceId,
    sessionId,
    billingSystemText,
    identityBlocks: [structuredClone(firstIdentityBlock), structuredClone(secondIdentityBlock)],
  });
  if (thinking !== undefined) rewritten["thinking"] = thinking;
  assertCacheControlBreakpointLimit(rewritten);

  appendAuditRecord({
    provider: "anthropic",
    headerRegistered: args.headerRegistered,
    metadataSessionMatchesHeader: true,
    maxTokens,
    thinkingBudgetTokens: budgetTokens,
    beta: policy.beta,
    betaResourcePath: "/v1/messages?beta=true",
    nativeAttestation: "placeholder-pending-live",
  });

  return rewritten;
}

const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}

function assertNoUnpairedSurrogates(value: unknown, path = "$"): void {
  if (typeof value === "string") {
    if (UNPAIRED_SURROGATE.test(value)) {
      throw new Error(`Anthropic attribution payload ${path} contains an unpaired surrogate`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertNoUnpairedSurrogates(entry, `${path}[${String(index)}]`);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertNoUnpairedSurrogates(entry, `${path}.${key}`);
    }
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Anthropic attribution ${label} must be a non-empty string`);
  }
  return value;
}

function convertContentBlocks(content: unknown, label: string): string | JsonObject[] {
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(`Anthropic attribution ${label} must be a non-empty content block array`);
  }
  const blocks: JsonObject[] = [];
  let hasImages = false;
  for (const [index, rawBlock] of content.entries()) {
    if (!isPlainObject(rawBlock)) {
      throw new Error(`Anthropic attribution ${label}[${String(index)}] must be a content block`);
    }
    if (rawBlock["type"] === "text") {
      blocks.push({
        type: "text",
        text: sanitizeSurrogates(
          nonEmptyString(rawBlock["text"], `${label}[${String(index)}].text`),
        ),
      });
      continue;
    }
    if (rawBlock["type"] === "image") {
      hasImages = true;
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: nonEmptyString(rawBlock["mimeType"], `${label}[${String(index)}].mimeType`),
          data: nonEmptyString(rawBlock["data"], `${label}[${String(index)}].data`),
        },
      });
      continue;
    }
    throw new Error(
      `Anthropic attribution ${label}[${String(index)}] has unsupported content block type ${String(rawBlock["type"])}`,
    );
  }
  if (!hasImages) {
    return blocks.map((block) => block["text"] as string).join("\n");
  }
  if (!blocks.some((block) => block["type"] === "text")) {
    blocks.unshift({ type: "text", text: "(see attached image)" });
  }
  return blocks;
}

function cloneMessageForCacheControl(message: JsonObject): JsonObject {
  const content = message["content"];
  return {
    ...message,
    ...(Array.isArray(content)
      ? { content: content.map((block) => (isPlainObject(block) ? { ...block } : block)) }
      : {}),
  };
}

function isCacheableConversationBlock(role: unknown, block: JsonObject): boolean {
  if (role === "assistant") return block["type"] === "text";
  return block["type"] === "text" || block["type"] === "image" || block["type"] === "tool_result";
}

function markMessageContentCacheSurface(
  message: JsonObject,
  cacheControl: AnthropicCacheControl,
): boolean {
  const role = message["role"];
  if (role !== "user" && role !== "assistant") return false;
  const content = message["content"];
  if (typeof content === "string") {
    if (content.trim().length === 0) return false;
    message["content"] = [{ type: "text", text: content, cache_control: { ...cacheControl } }];
    return true;
  }
  if (!Array.isArray(content)) return false;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (!isPlainObject(block) || !isCacheableConversationBlock(role, block)) continue;
    content[index] = cloneBlockWithCacheControl(block, cacheControl);
    return true;
  }
  return false;
}

function markLastConversationCacheSurface(
  messages: readonly JsonObject[],
  cacheControl: AnthropicCacheControl | undefined,
): JsonObject[] {
  const output = messages.map(cloneMessageForCacheControl);
  if (cacheControl === undefined) return output;
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const message = output[index];
    if (message !== undefined && markMessageContentCacheSurface(message, cacheControl)) break;
  }
  return output;
}

function convertAssistantBlocks(
  content: unknown,
  messageIndex: number,
  allowEmptySignature: boolean,
): JsonObject[] {
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(
      `Anthropic attribution assistant message ${String(messageIndex)} must have content blocks`,
    );
  }
  const converted: JsonObject[] = [];
  for (const [blockIndex, rawBlock] of content.entries()) {
    if (!isPlainObject(rawBlock)) {
      throw new Error(
        `Anthropic attribution assistant message ${String(messageIndex)} content block ${String(blockIndex)} must be an object`,
      );
    }
    const label = `assistant message ${String(messageIndex)} content block ${String(blockIndex)}`;
    if (rawBlock["type"] === "text") {
      converted.push({
        type: "text",
        text: sanitizeSurrogates(nonEmptyString(rawBlock["text"], `${label}.text`)),
      });
      continue;
    }
    if (rawBlock["type"] === "thinking") {
      if (rawBlock["redacted"] === true) {
        converted.push({
          type: "redacted_thinking",
          data: nonEmptyString(rawBlock["thinkingSignature"], `${label}.thinkingSignature`),
        });
        continue;
      }
      const thinking = sanitizeSurrogates(
        nonEmptyString(rawBlock["thinking"], `${label}.thinking`),
      );
      const thinkingSignature = rawBlock["thinkingSignature"];
      if (
        thinkingSignature === undefined ||
        (typeof thinkingSignature === "string" && thinkingSignature.trim().length === 0)
      ) {
        converted.push(
          allowEmptySignature
            ? { type: "thinking", thinking, signature: "" }
            : { type: "text", text: thinking },
        );
        continue;
      }
      converted.push({
        type: "thinking",
        thinking,
        signature: nonEmptyString(thinkingSignature, `${label}.thinkingSignature`),
      });
      continue;
    }
    if (rawBlock["type"] === "toolCall") {
      if (!isPlainObject(rawBlock["arguments"])) {
        throw new Error(`Anthropic attribution ${label}.arguments must be an object`);
      }
      converted.push({
        type: "tool_use",
        id: nonEmptyString(rawBlock["id"], `${label}.id`),
        name: nonEmptyString(rawBlock["name"], `${label}.name`),
        input: rawBlock["arguments"],
      });
      continue;
    }
    throw new Error(
      `Anthropic attribution assistant message ${String(messageIndex)} has unsupported content block type ${String(rawBlock["type"])}`,
    );
  }
  return converted;
}

function convertToolResultMessage(message: JsonObject, messageIndex: number): JsonObject {
  const isError = message["isError"];
  if (typeof isError !== "boolean") {
    throw new Error(
      `Anthropic attribution tool result message ${String(messageIndex)}.isError must be boolean`,
    );
  }
  return {
    type: "tool_result",
    tool_use_id: nonEmptyString(
      message["toolCallId"],
      `tool result message ${String(messageIndex)}.toolCallId`,
    ),
    content: convertContentBlocks(
      message["content"],
      `tool result message ${String(messageIndex)}.content`,
    ),
    is_error: isError,
  };
}

function convertMessages(
  messages: Context["messages"],
  cacheControl: AnthropicCacheControl | undefined,
  allowEmptySignature: boolean,
): JsonObject[] {
  const params: JsonObject[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const rawMessage: unknown = messages[index];
    if (!isPlainObject(rawMessage)) {
      throw new Error(`Anthropic attribution message ${String(index)} must be an object`);
    }
    const role = rawMessage["role"];
    if (role === "user") {
      const content = rawMessage["content"];
      params.push({
        role: "user",
        content:
          typeof content === "string"
            ? sanitizeSurrogates(nonEmptyString(content, `user message ${String(index)}.content`))
            : convertContentBlocks(content, `user message ${String(index)}.content`),
      });
      continue;
    }
    if (role === "assistant") {
      params.push({
        role: "assistant",
        content: convertAssistantBlocks(rawMessage["content"], index, allowEmptySignature),
      });
      continue;
    }
    if (role === "toolResult") {
      const toolResults = [convertToolResultMessage(rawMessage, index)];
      let lookahead = index + 1;
      while (lookahead < messages.length) {
        const next: unknown = messages[lookahead];
        if (!isPlainObject(next) || next["role"] !== "toolResult") break;
        toolResults.push(convertToolResultMessage(next, lookahead));
        lookahead += 1;
      }
      index = lookahead - 1;
      params.push({ role: "user", content: toolResults });
      continue;
    }
    throw new Error(
      `Anthropic attribution message role ${String(role)} at index ${String(index)} is unsupported`,
    );
  }
  if (params.length === 0) {
    throw new Error("Anthropic attribution requires at least one message");
  }
  return markLastConversationCacheSurface(params, cacheControl);
}

function convertTools(
  tools: readonly PiToolLike[] | undefined,
  supportsStrictTools: boolean,
  cacheControl?: AnthropicCacheControl,
): JsonObject[] {
  if (!tools || tools.length === 0) return [];
  return tools.map((tool, index) => {
    if (!isPlainObject(tool.parameters)) {
      throw new Error(`Anthropic attribution requires an object schema for tool ${tool.name}`);
    }
    const parameters = tool.parameters;
    if (parameters["type"] !== "object" || !isPlainObject(parameters["properties"])) {
      throw new Error(`Anthropic attribution requires an object schema for tool ${tool.name}`);
    }
    const required = parameters["required"];
    if (
      required !== undefined &&
      (!Array.isArray(required) || required.some((name) => typeof name !== "string"))
    ) {
      throw new Error(`Anthropic attribution tool ${tool.name} required must be a string array`);
    }
    if (tool.description !== undefined && typeof tool.description !== "string") {
      throw new Error(`Anthropic attribution tool ${tool.name} description must be a string`);
    }
    if (tool.constrainedSampling && tool.constrainedSampling.type === "grammar") {
      throw new Error(
        `Tool "${tool.name}" cannot use grammar constrained sampling with the Anthropic transport`,
      );
    }
    const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictTools);
    const resolvedParameters = getJsonSchemaToolParameters(tool, strict);
    const resolvedSchema = resolvedParameters as JsonObject;
    const legacyInputSchema: JsonObject = {
      type: "object",
      properties: resolvedSchema["properties"] ?? {},
      required: resolvedSchema["required"] ?? [],
    };
    const converted: JsonObject = {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(strict === true ? { strict: true } : {}),
      input_schema:
        strict === true ? { ...resolvedParameters, ...legacyInputSchema } : legacyInputSchema,
    };
    return cacheControl !== undefined && index === tools.length - 1
      ? cloneBlockWithCacheControl(converted, cacheControl)
      : converted;
  });
}

function thinkingBudgetFor(
  level: NonNullable<PiSimpleStreamOptions["reasoning"]>,
  maxTokens: number,
  custom?: PiSimpleStreamOptions["thinkingBudgets"],
): number {
  const defaults = {
    minimal: 1024,
    low: 4096,
    medium: 10240,
    high: 20480,
  } as const;
  const budgetLevel = level === "xhigh" || level === "max" ? "high" : level;
  const requested = custom?.[budgetLevel] ?? defaults[budgetLevel];
  if (requested >= maxTokens) {
    throw new Error("Anthropic attribution requires thinking budget below max tokens");
  }
  return requested;
}

function adaptiveEffortFor(
  model: PiModelLike,
  level: NonNullable<PiSimpleStreamOptions["reasoning"]>,
): string {
  const mapped = model.thinkingLevelMap?.[level];
  if (typeof mapped === "string") return mapped;
  if (mapped === null) {
    throw new Error(`Anthropic attribution model does not support reasoning=${level}`);
  }
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
  }
}

function resolveRequestMaxTokens(
  model: PiModelLike,
  requestedMaxTokens: number | undefined,
): number {
  const modelMaxTokens = resolveAnthropicMaxTokens(model);
  if (requestedMaxTokens === undefined) return modelMaxTokens;
  const requested = assertPositiveInteger(requestedMaxTokens, "maxTokens");
  if (requested > modelMaxTokens) {
    throw new Error(
      `Anthropic attribution maxTokens ${String(requested)} exceeds model.maxTokens ${String(modelMaxTokens)}`,
    );
  }
  return requested;
}

export function buildAnthropicRequestParams(
  model: PiModelLike,
  context: PiStreamContext,
  options?: PiSimpleStreamOptions,
): JsonObject {
  const policy = resolveClaudeCodeModelPolicy(model);
  const maxTokens = resolveRequestMaxTokens(model, options?.maxTokens);
  const cacheControl = resolveAnthropicCacheControl(model, options);
  const compatibility = anthropicCompatibility(model);
  const params: JsonObject = {
    model: policy.modelId,
    messages: convertMessages(context.messages, cacheControl, compatibility.allowEmptySignature),
    max_tokens: maxTokens,
    stream: true,
  };
  if (context.systemPrompt && context.systemPrompt.trim().length > 0) {
    params["system"] = markSystemCacheSurface(
      [
        {
          type: "text",
          text: sanitizeSurrogates(stripAnthropicSystemPromptBadLines(context.systemPrompt)),
        },
      ],
      cacheControl,
    );
  }
  const tools = convertTools(
    context.tools,
    compatibility.supportsStrictTools,
    compatibility.supportsCacheControlOnTools === false ? undefined : cacheControl,
  );
  if (tools.length > 0) params["tools"] = tools;
  else params["tools"] = [];
  const reasoning = options?.reasoning;
  if (reasoning !== undefined && options?.temperature !== undefined) {
    throw new Error("Anthropic attribution temperature is incompatible with thinking");
  }
  if (model.reasoning && reasoning !== undefined) {
    if (policy.thinkingPolicy === "adaptive-effort") {
      params["thinking"] = { type: "adaptive" };
      params["output_config"] = { effort: adaptiveEffortFor(model, reasoning) };
    } else {
      params["thinking"] = {
        type: "enabled",
        budget_tokens: thinkingBudgetFor(reasoning, maxTokens, options?.thinkingBudgets),
      };
    }
  } else {
    if (model.thinkingLevelMap?.off !== null) params["thinking"] = { type: "disabled" };
    if (options?.temperature !== undefined) {
      if (compatibility.supportsTemperature === false) {
        throw new Error(`Anthropic attribution temperature is not supported by model ${model.id}`);
      }
      params["temperature"] = options.temperature;
    }
  }
  assertCacheControlBreakpointLimit(params);
  return params;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateExpectedAnthropicAttribution(
  payload: JsonObject,
  expectedSessionId: string | undefined,
): ExpectedAnthropicAttribution {
  const proof = payload[ANTHROPIC_ATTRIBUTION_PROOF_KEY];
  delete payload[ANTHROPIC_ATTRIBUTION_PROOF_KEY];
  const expected = decodeAnthropicAttributionProof(proof);
  if (expectedSessionId !== undefined && expected.sessionId !== expectedSessionId) {
    throw new Error("Anthropic attribution expected session identity does not match request session");
  }
  const metadata = payload["metadata"];
  if (!isPlainObject(metadata) || typeof metadata["user_id"] !== "string") {
    throw new Error("Anthropic attribution metadata.user_id is required");
  }
  const identity = parseJsonObject(metadata["user_id"], "Anthropic attribution metadata.user_id");
  const identityKeys = Object.keys(identity).sort();
  if (identityKeys.join(",") !== "account_uuid,device_id,session_id") {
    throw new Error("Anthropic attribution metadata.user_id must contain the exact attribution identity");
  }
  if (identity["account_uuid"] !== expected.accountUuid) {
    throw new Error("Anthropic attribution account_uuid must match the expected attribution value");
  }
  if (identity["device_id"] !== expected.deviceId) {
    throw new Error("Anthropic attribution device_id must match the expected attribution value");
  }
  if (identity["session_id"] !== expected.sessionId) {
    throw new Error("Anthropic attribution session_id must match the expected attribution value");
  }
  const system = payload["system"];
  if (!Array.isArray(system) || system.length < expected.identityBlocks.length) {
    throw new Error("Anthropic attribution required system identity blocks are missing");
  }
  if (!sameJsonValue(system[0], expected.identityBlocks[0])) {
    throw new Error("Anthropic attribution billing identity must remain the exact expected value");
  }
  if (!sameJsonValue(system[1], expected.identityBlocks[1])) {
    throw new Error("Anthropic attribution required system identity must remain the exact expected value");
  }
  if (
    !isPlainObject(system[0]) ||
    system[0]["text"] !== expected.billingSystemText ||
    !isPlainObject(system[1]) ||
    system[1]["text"] !== CLAUDE_AGENT_SDK_SYSTEM_TEXT
  ) {
    throw new Error("Anthropic attribution required system identity blocks are malformed");
  }
  return expected;
}

function validateFinalAnthropicPayload(
  payload: JsonObject,
  model: PiModelLike,
  expectedMaxTokens: number,
  expectedSessionId: string | undefined,
): ExpectedAnthropicAttribution {
  const expectedAttribution = validateExpectedAnthropicAttribution(payload, expectedSessionId);
  assertJsonValue(payload);
  assertNoUnpairedSurrogates(payload);
  const policy = resolveClaudeCodeModelPolicy(model);
  if (payload["model"] !== policy.modelId) {
    throw new Error(
      `Anthropic attribution payload model must remain ${policy.modelId}; got ${String(payload["model"])}`,
    );
  }
  const maxTokens = assertPositiveInteger(payload["max_tokens"], "max_tokens");
  if (maxTokens !== expectedMaxTokens) {
    throw new Error(
      `Anthropic attribution payload max_tokens must remain ${String(expectedMaxTokens)}; got ${String(maxTokens)}`,
    );
  }
  rewriteThinking(payload, maxTokens);
  assertCacheControlBreakpointLimit(payload);
  return expectedAttribution;
}

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers.entries()]);
}

interface ResolvedHeader {
  readonly name: string;
  readonly value: string;
}

function applyHeaders(
  target: Map<string, ResolvedHeader>,
  headers: Record<string, string | null> | undefined,
): void {
  if (headers === undefined) return;
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value === null) target.delete(key);
    else target.set(key, { name, value });
  }
}

function requireResolvedHeader(
  headers: Map<string, ResolvedHeader>,
  name: string,
  expectedValue: string,
): void {
  const resolved = headers.get(name.toLowerCase());
  if (resolved === undefined) {
    throw new Error(`Anthropic attribution ${name} header is required`);
  }
  if (resolved.value !== expectedValue) {
    throw new Error(
      `Anthropic attribution ${name} header must match the resolved attribution value`,
    );
  }
}

function buildFetchHeaders(
  model: PiModelLike,
  options: PiSimpleStreamOptions | undefined,
  apiKey: string,
  sessionHeader: string,
  beta: string,
): Record<string, string> {
  const authorization = `Bearer ${apiKey}`;
  const headers = new Map<string, ResolvedHeader>();
  applyHeaders(headers, {
    Accept: "application/json",
    Authorization: authorization,
    "Content-Type": "application/json",
    "User-Agent": CLAUDE_CODE_USER_AGENT,
    [CLAUDE_CODE_SESSION_HEADER]: sessionHeader,
    "anthropic-beta": beta,
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": "2023-06-01",
    "x-app": "cli",
  });
  applyHeaders(headers, model.headers);
  applyHeaders(headers, options?.headers);

  requireResolvedHeader(headers, "Authorization", authorization);
  requireResolvedHeader(headers, "Content-Type", "application/json");
  requireResolvedHeader(headers, CLAUDE_CODE_SESSION_HEADER, sessionHeader);
  requireResolvedHeader(headers, "anthropic-beta", beta);
  requireResolvedHeader(headers, "anthropic-dangerous-direct-browser-access", "true");
  requireResolvedHeader(headers, "anthropic-version", "2023-06-01");
  requireResolvedHeader(headers, "x-app", "cli");

  return Object.fromEntries([...headers.values()].map(({ name, value }) => [name, value]));
}

function mapStopReason(
  reason: unknown,
  stopDetails: unknown,
): {
  readonly stopReason: "stop" | "length" | "toolUse" | "error";
  readonly errorMessage?: string;
} {
  switch (reason) {
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
      return { stopReason: "stop" };
    case "max_tokens":
      return { stopReason: "length" };
    case "tool_use":
      return { stopReason: "toolUse" };
    case "refusal": {
      const explanation = isPlainObject(stopDetails) ? stopDetails["explanation"] : undefined;
      return {
        stopReason: "error",
        errorMessage:
          typeof explanation === "string" && explanation.length > 0
            ? explanation
            : "The model refused to complete the request",
      };
    }
    case "sensitive":
      return { stopReason: "error", errorMessage: "Provider stopped with: sensitive" };
    default:
      throw new Error(`Anthropic attribution received unknown stop reason: ${String(reason)}`);
  }
}

function parseStreamingJsonFragment(text: string): unknown | undefined {
  try {
    return parseJsonSource(text);
  } catch {
    return undefined;
  }
}

function parseCompleteToolArguments(text: string): JsonObject {
  const value = parseJsonValue(text, "Anthropic streamed tool arguments");
  if (!isPlainObject(value)) {
    throw new Error("Anthropic streamed tool arguments must be a JSON object");
  }
  return value;
}

function validCostRate(value: unknown, field: string): number {
  if (value === undefined) {
    throw new Error(`Anthropic attribution model ${field} is required`);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Anthropic attribution model ${field} must be a finite non-negative number`);
  }
  return value;
}

function resolveModelCostRates(
  model: PiModelLike,
  totalInputTokens: number,
): Required<Pick<PiCostRatesLike, "input" | "output" | "cacheRead" | "cacheWrite">> {
  const baseCost = model.cost;
  if (baseCost === undefined) throw new Error("Anthropic attribution model cost is required");
  let selected: PiCostRatesLike = baseCost;
  let selectedLabel = "cost";
  let matchedThreshold = -1;
  if (baseCost.tiers !== undefined && !Array.isArray(baseCost.tiers)) {
    throw new Error("Anthropic attribution model cost.tiers must be an array");
  }
  for (const [index, tier] of (baseCost.tiers ?? []).entries()) {
    if (!isPlainObject(tier)) {
      throw new Error(`Anthropic attribution model cost.tiers[${String(index)}] must be an object`);
    }
    const threshold = tier["inputTokensAbove"];
    if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) {
      throw new Error(
        `Anthropic attribution model cost.tiers[${String(index)}].inputTokensAbove must be a finite non-negative number`,
      );
    }
    validCostRate(tier["input"], `cost.tiers[${String(index)}].input`);
    validCostRate(tier["output"], `cost.tiers[${String(index)}].output`);
    validCostRate(tier["cacheRead"], `cost.tiers[${String(index)}].cacheRead`);
    validCostRate(tier["cacheWrite"], `cost.tiers[${String(index)}].cacheWrite`);
    if (totalInputTokens > threshold && threshold > matchedThreshold) {
      selected = tier;
      selectedLabel = `cost.tiers[${String(index)}]`;
      matchedThreshold = threshold;
    }
  }
  return {
    input: validCostRate(selected.input, `${selectedLabel}.input`),
    output: validCostRate(selected.output, `${selectedLabel}.output`),
    cacheRead: validCostRate(selected.cacheRead, `${selectedLabel}.cacheRead`),
    cacheWrite: validCostRate(selected.cacheWrite, `${selectedLabel}.cacheWrite`),
  };
}

function requiredUsageInteger(usage: JsonObject, key: string): number {
  const value = usage[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Anthropic attribution received malformed usage.${key}; expected a non-negative safe integer`,
    );
  }
  return value;
}

function nullableUsageInteger(usage: JsonObject, key: string): number | null {
  const value = usage[key];
  if (value === null) return null;
  return requiredUsageInteger(usage, key);
}

export function updateAnthropicUsage(
  output: AssistantMessageLike,
  usage: JsonObject,
  model: PiModelLike,
  phase: "message_start" | "message_delta",
): void {
  const inputTokens =
    phase === "message_start"
      ? requiredUsageInteger(usage, "input_tokens")
      : nullableUsageInteger(usage, "input_tokens");
  const outputTokens = requiredUsageInteger(usage, "output_tokens");
  const cacheReadTokens = nullableUsageInteger(usage, "cache_read_input_tokens");
  const cacheWriteTokens = nullableUsageInteger(usage, "cache_creation_input_tokens");
  if (inputTokens !== null) output.usage.input = inputTokens;
  output.usage.output = outputTokens;
  if (cacheReadTokens !== null) output.usage.cacheRead = cacheReadTokens;
  if (cacheWriteTokens !== null) output.usage.cacheWrite = cacheWriteTokens;

  if (phase === "message_start") {
    const cacheCreation = usage["cache_creation"];
    if (cacheCreation !== null && !isPlainObject(cacheCreation)) {
      throw new Error(
        "Anthropic attribution received malformed usage.cache_creation; expected an object or null",
      );
    }
    if (cacheCreation === null) {
      output.usage.cacheWrite1h = 0;
    } else {
      output.usage.cacheWrite1h = requiredUsageInteger(cacheCreation, "ephemeral_1h_input_tokens");
      requiredUsageInteger(cacheCreation, "ephemeral_5m_input_tokens");
    }
  }
  const longCacheWrite = output.usage.cacheWrite1h ?? 0;
  if (
    !Number.isFinite(longCacheWrite) ||
    !Number.isInteger(longCacheWrite) ||
    longCacheWrite < 0 ||
    longCacheWrite > output.usage.cacheWrite
  ) {
    throw new Error(
      "Anthropic attribution received malformed 1h cache usage exceeding total cache writes",
    );
  }
  output.usage.totalTokens =
    output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  const rates = resolveModelCostRates(
    model,
    output.usage.input + output.usage.cacheRead + output.usage.cacheWrite,
  );
  const shortCacheWrite = output.usage.cacheWrite - longCacheWrite;
  output.usage.cost.input = (output.usage.input * rates.input) / 1_000_000;
  output.usage.cost.output = (output.usage.output * rates.output) / 1_000_000;
  output.usage.cost.cacheRead = (output.usage.cacheRead * rates.cacheRead) / 1_000_000;
  output.usage.cost.cacheWrite =
    (shortCacheWrite * rates.cacheWrite + longCacheWrite * rates.input * 2) / 1_000_000;
  output.usage.cost.total =
    output.usage.cost.input +
    output.usage.cost.output +
    output.usage.cost.cacheRead +
    output.usage.cost.cacheWrite;
}

interface ParsedSseEvent {
  readonly name: string;
  readonly payload: JsonObject;
}

async function* iterateSseEvents(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<ParsedSseEvent> {
  if (!response.body) throw new Error("Anthropic beta messages response had no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];
  function flush(): ParsedSseEvent | undefined {
    if (eventName === undefined && dataLines.length === 0) return undefined;
    if (eventName === undefined) {
      throw new Error("Anthropic beta messages SSE record is missing its event field");
    }
    if (dataLines.length === 0) {
      throw new Error(`Anthropic beta messages SSE ${eventName} record is missing data`);
    }
    const data = dataLines.join("\n");
    const name = eventName;
    eventName = undefined;
    dataLines = [];
    const payload = parseJsonObject(data, `Anthropic beta messages SSE ${name} event`);
    if (payload["type"] !== name) {
      throw new Error(
        `Anthropic beta messages SSE event/type mismatch: event ${name}, payload ${String(payload["type"])}`,
      );
    }
    return { name, payload };
  }
  function consumeLine(line: string): ParsedSseEvent | undefined {
    if (line.length === 0) return flush();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      if (eventName !== undefined) {
        throw new Error("Anthropic beta messages SSE record has multiple event fields");
      }
      eventName = nonEmptyString(value, "SSE event field");
    } else if (field === "data") {
      dataLines.push(value);
    } else {
      throw new Error(`Anthropic beta messages SSE record has unsupported field ${field}`);
    }
    return undefined;
  }
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const match = /\r\n|\n|\r/.exec(buffer);
        if (match?.index === undefined) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = consumeLine(line);
        if (event !== undefined) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0 || eventName !== undefined || dataLines.length > 0) {
      throw new Error("Anthropic beta messages SSE stream ended with an incomplete record");
    }
  } finally {
    reader.releaseLock();
  }
}

function createOutput(model: PiModelLike): AssistantMessageLike {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

interface RequestAbortScope {
  readonly signal: AbortSignal | undefined;
  readonly timedOut: () => boolean;
  close(): void;
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Anthropic attribution ${label} must be a non-negative safe integer`);
  }
  return value;
}

function transportOptions(options: PiSimpleStreamOptions | undefined): {
  readonly maxRetries: number;
  readonly maxRetryDelayMs: number | undefined;
  readonly timeoutMs: number | undefined;
} {
  const maxRetries =
    options?.maxRetries === undefined
      ? 0
      : assertNonNegativeInteger(options.maxRetries, "maxRetries");
  const maxRetryDelayMs =
    options?.maxRetryDelayMs === undefined
      ? undefined
      : assertNonNegativeInteger(options.maxRetryDelayMs, "maxRetryDelayMs");
  const timeoutMs =
    options?.timeoutMs === undefined
      ? undefined
      : assertPositiveInteger(options.timeoutMs, "timeoutMs");
  return { maxRetries, maxRetryDelayMs, timeoutMs };
}

function requestTimeoutError(timeoutMs: number): Error {
  return new Error(`Anthropic beta messages request timed out after ${String(timeoutMs)} ms`);
}

function createRequestAbortScope(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): RequestAbortScope {
  if (timeoutMs === undefined) {
    return { signal: parentSignal, timedOut: () => false, close: () => undefined };
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(requestTimeoutError(timeoutMs));
  }, timeoutMs);
  const abortFromParent = (): void => {
    controller.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    close: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function retryableHttpResponse(response: Response): boolean {
  const shouldRetry = response.headers.get("x-should-retry");
  if (shouldRetry === "true") return true;
  if (shouldRetry === "false") return false;
  return response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
}

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

function retryDelayMs(
  headers: Headers | undefined,
  retryIndex: number,
  maxRetryDelayMs: number | undefined,
  errorMessage: string,
): number {
  const retryAfterMs = headers?.get("retry-after-ms");
  let delayMs: number;
  if (retryAfterMs !== null && retryAfterMs !== undefined) {
    const parsed = Number.parseFloat(retryAfterMs);
    delayMs = Number.isNaN(parsed) ? 500 * 2 ** retryIndex : parsed;
  } else {
    const retryAfter = headers?.get("retry-after");
    if (retryAfter !== null && retryAfter !== undefined) {
      const seconds = Number.parseFloat(retryAfter);
      delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
    } else {
      delayMs = 500 * 2 ** retryIndex;
    }
  }
  const maximum = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  if (maximum > 0 && delayMs > maximum) {
    throw new Error(
      `Server requested ${String(Math.ceil(delayMs / 1000))}s retry delay (max: ${String(Math.ceil(maximum / 1000))}s). ${errorMessage}`,
    );
  }
  return Math.max(0, delayMs);
}

function abortableDelay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request was aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new Error("Request was aborted"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchAnthropicResponse(input: {
  readonly fetch: FetchFunction;
  readonly url: string;
  readonly requestInit: RequestInit;
  readonly parentSignal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
  readonly maxRetries: number;
  readonly maxRetryDelayMs: number | undefined;
}): Promise<{ readonly response: Response; readonly abortScope: RequestAbortScope }> {
  let attempt = 0;
  for (;;) {
    const abortScope = createRequestAbortScope(input.parentSignal, input.timeoutMs);
    let response: Response;
    try {
      response = await input.fetch(input.url, {
        ...input.requestInit,
        ...(abortScope.signal === undefined ? {} : { signal: abortScope.signal }),
      });
    } catch (error) {
      const timedOut = abortScope.timedOut();
      abortScope.close();
      if (timedOut && input.timeoutMs !== undefined) throw requestTimeoutError(input.timeoutMs);
      if (input.parentSignal?.aborted) throw new Error("Request was aborted");
      if (attempt === input.maxRetries) throw error;
      const delay = retryDelayMs(
        undefined,
        attempt,
        input.maxRetryDelayMs,
        error instanceof Error ? error.message : String(error),
      );
      attempt += 1;
      await abortableDelay(delay, input.parentSignal);
      continue;
    }
    if (retryableHttpResponse(response) && attempt < input.maxRetries) {
      const errorMessage = `Anthropic beta messages request failed: HTTP ${String(response.status)} ${response.statusText}`;
      let delay: number;
      try {
        delay = retryDelayMs(response.headers, attempt, input.maxRetryDelayMs, errorMessage);
      } catch (error) {
        await response.body?.cancel();
        abortScope.close();
        throw error;
      }
      await response.body?.cancel();
      abortScope.close();
      attempt += 1;
      await abortableDelay(delay, input.parentSignal);
      continue;
    }
    return { response, abortScope };
  }
}

function sseIndex(payload: JsonObject, eventName: string): number {
  const index = payload["index"];
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
    throw new Error(`Anthropic beta messages SSE ${eventName} index must be non-negative`);
  }
  return index;
}

function sseUsage(payload: JsonObject, eventName: string): JsonObject {
  const usage = payload["usage"];
  if (!isPlainObject(usage)) {
    throw new Error(`Anthropic beta messages SSE ${eventName} usage object is required`);
  }
  return usage;
}

type StreamingTextBlock = TextContent & { index?: number };
type StreamingThinkingBlock = ThinkingContent & { index?: number };
type StreamingToolCall = ToolCall & { index?: number; partialJson?: string };
type StreamingBlock = StreamingTextBlock | StreamingThinkingBlock | StreamingToolCall;

async function processAnthropicSse(
  response: Response,
  signal: AbortSignal | undefined,
  output: AssistantMessageLike,
  stream: AssistantMessageEventStreamLike,
  model: PiModelLike,
): Promise<void> {
  const blocks = output.content as unknown as StreamingBlock[];
  const activeBlocks = new Map<number, number>();
  const seenBlockIndices = new Set<number>();
  let sawMessageStart = false;
  let sawMessageDelta = false;
  let sawMessageStop = false;

  for await (const parsed of iterateSseEvents(response, signal)) {
    const event = parsed.payload;
    if (sawMessageStop) {
      throw new Error(`Anthropic beta messages SSE sequence continued after message_stop`);
    }
    if (parsed.name === "ping") continue;
    if (parsed.name === "error") {
      const providerError = event["error"];
      if (!isPlainObject(providerError)) {
        throw new Error("Anthropic beta messages SSE error event has malformed error payload");
      }
      throw new Error(
        `Anthropic beta messages SSE error: ${nonEmptyString(providerError["message"], "SSE error.message")}`,
      );
    }
    if (parsed.name === "message_start") {
      if (sawMessageStart) {
        throw new Error(
          "Anthropic beta messages SSE sequence contains multiple message_start events",
        );
      }
      const message = event["message"];
      if (!isPlainObject(message)) {
        throw new Error("Anthropic beta messages SSE message_start.message must be an object");
      }
      output.responseId = nonEmptyString(message["id"], "SSE message_start response id");
      updateAnthropicUsage(
        output,
        sseUsage(message, "message_start.message"),
        model,
        "message_start",
      );
      sawMessageStart = true;
      continue;
    }
    if (!sawMessageStart) {
      throw new Error(
        `Anthropic beta messages SSE sequence received ${parsed.name} before message_start`,
      );
    }
    if (parsed.name === "content_block_start") {
      if (sawMessageDelta) {
        throw new Error("Anthropic beta messages SSE content block started after message_delta");
      }
      const index = sseIndex(event, parsed.name);
      if (seenBlockIndices.has(index)) {
        throw new Error(
          `Anthropic beta messages SSE content block index ${String(index)} was reused`,
        );
      }
      const contentBlock = event["content_block"];
      if (!isPlainObject(contentBlock)) {
        throw new Error(
          "Anthropic beta messages SSE content_block_start.content_block is malformed",
        );
      }
      if (contentBlock["type"] === "text") {
        const text = contentBlock["text"];
        if (typeof text !== "string") {
          throw new Error("Anthropic beta messages SSE text content block requires text");
        }
        blocks.push({ type: "text", text, index });
        stream.push({
          type: "text_start",
          contentIndex: output.content.length - 1,
          partial: output,
        });
      } else if (contentBlock["type"] === "thinking") {
        const thinking = contentBlock["thinking"];
        const signature = contentBlock["signature"];
        if (typeof thinking !== "string" || typeof signature !== "string") {
          throw new Error(
            "Anthropic beta messages SSE thinking content block requires thinking and signature",
          );
        }
        blocks.push({
          type: "thinking",
          thinking,
          thinkingSignature: signature,
          index,
        });
        stream.push({
          type: "thinking_start",
          contentIndex: output.content.length - 1,
          partial: output,
        });
      } else if (contentBlock["type"] === "redacted_thinking") {
        blocks.push({
          type: "thinking",
          thinking: "[Reasoning redacted]",
          thinkingSignature: nonEmptyString(
            contentBlock["data"],
            "SSE redacted_thinking content block data",
          ),
          redacted: true,
          index,
        });
        stream.push({
          type: "thinking_start",
          contentIndex: output.content.length - 1,
          partial: output,
        });
      } else if (contentBlock["type"] === "tool_use") {
        if (!isPlainObject(contentBlock["input"])) {
          throw new Error("Anthropic beta messages SSE tool_use input must be an object");
        }
        blocks.push({
          type: "toolCall",
          id: nonEmptyString(contentBlock["id"], "SSE tool_use id"),
          name: nonEmptyString(contentBlock["name"], "SSE tool_use name"),
          arguments: contentBlock["input"],
          partialJson: "",
          index,
        });
        stream.push({
          type: "toolcall_start",
          contentIndex: output.content.length - 1,
          partial: output,
        });
      } else {
        throw new Error(
          `Anthropic beta messages SSE content block type ${String(contentBlock["type"])} is unsupported`,
        );
      }
      seenBlockIndices.add(index);
      activeBlocks.set(index, output.content.length - 1);
      continue;
    }
    if (parsed.name === "content_block_delta") {
      const index = sseIndex(event, parsed.name);
      const blockIndex = activeBlocks.get(index);
      if (blockIndex === undefined) {
        throw new Error(
          `Anthropic beta messages SSE content block delta has no active block at index ${String(index)}`,
        );
      }
      const block = blocks[blockIndex];
      if (block === undefined) {
        throw new Error(`Anthropic beta messages SSE content block ${String(index)} is missing`);
      }
      const delta = event["delta"];
      if (!isPlainObject(delta)) {
        throw new Error("Anthropic beta messages SSE content_block_delta.delta must be an object");
      }
      if (delta["type"] === "text_delta" && block["type"] === "text") {
        const text = delta["text"];
        if (typeof text !== "string") {
          throw new Error("Anthropic beta messages SSE text_delta.text must be a string");
        }
        block["text"] = `${block["text"] as string}${text}`;
        stream.push({ type: "text_delta", contentIndex: blockIndex, delta: text, partial: output });
      } else if (delta["type"] === "thinking_delta" && block["type"] === "thinking") {
        const thinking = delta["thinking"];
        if (typeof thinking !== "string") {
          throw new Error("Anthropic beta messages SSE thinking_delta.thinking must be a string");
        }
        block["thinking"] = `${block["thinking"] as string}${thinking}`;
        stream.push({
          type: "thinking_delta",
          contentIndex: blockIndex,
          delta: thinking,
          partial: output,
        });
      } else if (delta["type"] === "input_json_delta" && block["type"] === "toolCall") {
        const partialJson = delta["partial_json"];
        if (typeof partialJson !== "string" || typeof block.partialJson !== "string") {
          throw new Error("Anthropic beta messages SSE tool JSON delta is malformed");
        }
        block.partialJson += partialJson;
        const partialArguments = parseStreamingJsonFragment(block.partialJson);
        if (isPlainObject(partialArguments)) block.arguments = partialArguments;
        stream.push({
          type: "toolcall_delta",
          contentIndex: blockIndex,
          delta: partialJson,
          partial: output,
        });
      } else if (delta["type"] === "signature_delta" && block["type"] === "thinking") {
        const signature = delta["signature"];
        if (typeof signature !== "string") {
          throw new Error("Anthropic beta messages SSE signature_delta.signature must be a string");
        }
        block["thinkingSignature"] = `${block["thinkingSignature"] as string}${signature}`;
      } else {
        throw new Error(
          `Anthropic beta messages SSE delta ${String(delta["type"])} does not match its active content block`,
        );
      }
      continue;
    }
    if (parsed.name === "content_block_stop") {
      const index = sseIndex(event, parsed.name);
      const blockIndex = activeBlocks.get(index);
      if (blockIndex === undefined) {
        throw new Error(
          `Anthropic beta messages SSE content block stop has no active block at index ${String(index)}`,
        );
      }
      const block = blocks[blockIndex];
      if (block === undefined) {
        throw new Error(`Anthropic beta messages SSE content block ${String(index)} is missing`);
      }
      activeBlocks.delete(index);
      delete block.index;
      if (block["type"] === "text") {
        stream.push({
          type: "text_end",
          contentIndex: blockIndex,
          content: block["text"] as string,
          partial: output,
        });
      } else if (block["type"] === "thinking") {
        stream.push({
          type: "thinking_end",
          contentIndex: blockIndex,
          content: block["thinking"] as string,
          partial: output,
        });
      } else if (block["type"] === "toolCall") {
        if (typeof block.partialJson !== "string") {
          throw new Error("Anthropic beta messages SSE tool call lost its JSON accumulator");
        }
        if (block.partialJson.length > 0) {
          block["arguments"] = parseCompleteToolArguments(block.partialJson);
        }
        delete block.partialJson;
        stream.push({
          type: "toolcall_end",
          contentIndex: blockIndex,
          toolCall: block,
          partial: output,
        });
      } else {
        throw new Error("Anthropic beta messages SSE active content block has an invalid type");
      }
      continue;
    }
    if (parsed.name === "message_delta") {
      if (sawMessageDelta || activeBlocks.size > 0) {
        throw new Error(
          "Anthropic beta messages SSE message_delta arrived before all content blocks stopped",
        );
      }
      const delta = event["delta"];
      if (!isPlainObject(delta)) {
        throw new Error("Anthropic beta messages SSE message_delta.delta must be an object");
      }
      const mappedStopReason = mapStopReason(
        nonEmptyString(delta["stop_reason"], "SSE message_delta.stop_reason"),
        delta["stop_details"],
      );
      output.stopReason = mappedStopReason.stopReason;
      output.errorMessage = mappedStopReason.errorMessage;
      updateAnthropicUsage(output, sseUsage(event, "message_delta"), model, "message_delta");
      if (mappedStopReason.errorMessage !== undefined) {
        throw new Error(mappedStopReason.errorMessage);
      }
      sawMessageDelta = true;
      continue;
    }
    if (parsed.name === "message_stop") {
      if (!sawMessageDelta || activeBlocks.size > 0) {
        throw new Error(
          "Anthropic beta messages SSE message_stop arrived before message_delta or block closure",
        );
      }
      sawMessageStop = true;
      continue;
    }
    throw new Error(`Anthropic beta messages SSE event ${parsed.name} is unsupported`);
  }

  if (!sawMessageStop) {
    throw new Error("Anthropic beta messages SSE stream ended before message_stop");
  }
}

export function streamAnthropicViaBetaMessages(
  model: Model<Api>,
  context: PiStreamContext,
  options?: PiSimpleStreamOptions,
): AssistantMessageEventStreamLike {
  const anthropicModel = requireAnthropicModel(model);
  const stream = createAssistantMessageEventStream();
  const output = createOutput(anthropicModel);

  void (async () => {
    let activeAbortScope: RequestAbortScope | undefined;
    try {
      const apiKey = options?.apiKey;
      if (typeof apiKey !== "string" || apiKey.length === 0) {
        throw new Error(
          "Anthropic attribution requires Pi OAuth apiKey/token; no credential was supplied",
        );
      }
      if (!apiKey.includes("sk-ant-oat")) {
        throw new Error(
          "Anthropic attribution refuses non-OAuth Anthropic credential; subscription OAuth token is required",
        );
      }

      const policy = resolveClaudeCodeModelPolicy(anthropicModel);
      const expectedMaxTokens = resolveRequestMaxTokens(anthropicModel, options?.maxTokens);
      let params = buildAnthropicRequestParams(anthropicModel, context, options);
      const nextParams = await options?.onPayload?.(params, anthropicModel);
      if (nextParams !== undefined) {
        if (!isPlainObject(nextParams))
          throw new Error("Anthropic attribution onPayload returned a non-object payload");
        params = nextParams;
      }
      const expectedAttribution = validateFinalAnthropicPayload(
        params,
        anthropicModel,
        expectedMaxTokens,
        options?.sessionId,
      );
      const sessionId = expectedAttribution.sessionId;

      const configuredTransport = transportOptions(options);
      if (
        typeof anthropicModel.baseUrl !== "string" ||
        anthropicModel.baseUrl.trim().length === 0
      ) {
        throw new Error("Anthropic attribution model.baseUrl resolved endpoint is required");
      }
      const baseUrl = anthropicModel.baseUrl.replace(/\/+$/, "");
      if (baseUrl.length === 0) {
        throw new Error("Anthropic attribution model.baseUrl resolved endpoint is required");
      }
      const url = `${baseUrl}/v1/messages?beta=true`;
      const headers = buildFetchHeaders(anthropicModel, options, apiKey, sessionId, policy.beta);
      const requestInit: RequestInit = {
        method: "POST",
        headers,
        body: JSON.stringify(params),
      };
      const fetched = await fetchAnthropicResponse({
        fetch: options?.fetch ?? globalThis.fetch,
        url,
        requestInit,
        parentSignal: options?.signal,
        timeoutMs: configuredTransport.timeoutMs,
        maxRetries: configuredTransport.maxRetries,
        maxRetryDelayMs: configuredTransport.maxRetryDelayMs,
      });
      const response = fetched.response;
      activeAbortScope = fetched.abortScope;
      await options?.onResponse?.(
        { status: response.status, headers: headersToRecord(response.headers) },
        anthropicModel,
      );
      if (!response.ok) {
        throw new Error(
          `Anthropic beta messages request failed: HTTP ${response.status} ${response.statusText}: ${await response.text()}`,
        );
      }

      stream.push({ type: "start", partial: output });
      await processAnthropicSse(response, activeAbortScope.signal, output, stream, anthropicModel);
      if (options?.signal?.aborted) throw new Error("Request was aborted");
      activeAbortScope.close();
      activeAbortScope = undefined;
      if (
        output.stopReason !== "stop" &&
        output.stopReason !== "length" &&
        output.stopReason !== "toolUse"
      ) {
        throw new Error(
          `Anthropic beta messages settled with invalid success reason ${String(output.stopReason)}`,
        );
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      activeAbortScope?.close();
      activeAbortScope = undefined;
      for (const block of output.content as unknown as StreamingBlock[]) {
        delete block.index;
        if (block.type === "toolCall") delete block.partialJson;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

interface AnthropicAttributionClaimProbe {
  readonly schema_version: typeof ANTHROPIC_ATTRIBUTION_CLAIM_SCHEMA;
  readonly acknowledge: () => void;
}

function isAnthropicAttributionClaimProbe(value: unknown): value is AnthropicAttributionClaimProbe {
  return (
    isPlainObject(value) &&
    value["schema_version"] === ANTHROPIC_ATTRIBUTION_CLAIM_SCHEMA &&
    typeof value["acknowledge"] === "function"
  );
}

export interface AnthropicAttributionExtensionOptions {
  readonly loadAccount: () => ClaudeAttributionAccount;
}

/**
 * Build the child-Agent attribution extension factory owned by this runtime.
 * The factory registers only the Anthropic provider transport and payload hook.
 */
export function createAnthropicAttributionExtension(
  options: AnthropicAttributionExtensionOptions,
): ExtensionFactory {
  return (pi) => {
    const acknowledgements: true[] = [];
    const probe: AnthropicAttributionClaimProbe = {
      schema_version: ANTHROPIC_ATTRIBUTION_CLAIM_SCHEMA,
      acknowledge: () => {
        acknowledgements.push(true);
      },
    };
    pi.events.emit(ANTHROPIC_ATTRIBUTION_CLAIM_CHANNEL, probe);
    if (acknowledgements.length > 0) {
      throw new Error("Anthropic attribution ownership is already claimed");
    }

    const streamSimple: HostStreamSimple = (model, context, streamOptions) =>
      streamAnthropicViaBetaMessages(requireAnthropicModel(model), context, streamOptions);
    pi.registerProvider("anthropic", {
      api: "anthropic-messages",
      streamSimple,
    });

    pi.on("before_provider_request", (event, ctx) => {
      if (!isAnthropicContext(ctx as AnthropicContextLike)) return undefined;
      return rewriteAnthropicRequestPayload({
        payload: event.payload,
        ctx: ctx as AnthropicContextLike,
        account: options.loadAccount(),
        headerRegistered: true,
        cacheRetention: undefined,
      });
    });

    pi.events.on(ANTHROPIC_ATTRIBUTION_CLAIM_CHANNEL, (value) => {
      if (isAnthropicAttributionClaimProbe(value)) value.acknowledge();
    });
  };
}

export const anthropicAttributionExtension = createAnthropicAttributionExtension({
  loadAccount: loadClaudeAttributionAccount,
});
