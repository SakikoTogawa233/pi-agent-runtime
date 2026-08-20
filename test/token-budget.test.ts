import { describe, expect, it } from "vitest";
import {
  allowedInputTokens,
  estimateInputTokens,
  knownTextSegment,
  resolveTokenBudgetFamily,
  TOKEN_BUDGET_AFFINE_TOKENS,
  unknownOutputContractSegment,
  utf8ByteClassBreakdown,
} from "../src/token-budget.js";

describe("token estimation", () => {
  it("keeps the extracted affine byte-ceiling vector for strict child launches", () => {
    const estimate = estimateInputTokens({
      family: "openai-codex",
      profile: "strict-launch",
      allowedInputTokens: 100_000,
      calibrationBacked: true,
      familyResolution: "model_override",
      segments: [knownTextSegment("x".repeat(23_674))],
    });
    expect(TOKEN_BUDGET_AFFINE_TOKENS).toBe(512);
    expect(estimate.tokens).toBe(24_186);
    expect(estimate.rateSource.source).toBe("strict_launch");
    expect(estimate.rateSource.effective_rate_bytes_per_token_x100).toBe(100);
  });

  it("accounts for multibyte UTF-8 and unknown output contracts independently", () => {
    expect(utf8ByteClassBreakdown("a €")).toEqual({
      bytes: 5,
      multibyteBytes: 3,
      denseBytes: 0,
      asciiWhitespaceBytes: 1,
    });
    const estimate = estimateInputTokens({
      family: "unknown",
      profile: "provable",
      allowedInputTokens: undefined,
      calibrationBacked: false,
      familyResolution: "unknown_provider_floor",
      segments: [knownTextSegment("a €"), unknownOutputContractSegment(100)],
    });
    expect(estimate.byte_class_breakdown).toEqual({
      total_bytes: 105,
      normal_bytes: 2,
      multibyte_bytes: 3,
      dense_bytes: 0,
      unknown_output_contract_bytes: 100,
    });
    expect(estimate.tokens).toBe(616);
  });

  it("resolves only the frozen backed model set and fails malformed arithmetic loudly", () => {
    expect(
      resolveTokenBudgetFamily({ provider: "anthropic", model: "claude-opus-5" }),
    ).toMatchObject({
      family: "anthropic",
      backed: true,
      resolution: "model_override",
    });
    expect(
      resolveTokenBudgetFamily({ provider: "anthropic", model: "unknown-model" }),
    ).toMatchObject({
      family: "anthropic",
      backed: false,
      resolution: "known_provider_unbacked_model",
    });
    expect(() => unknownOutputContractSegment(-1)).toThrow(/non-negative/);
    expect(
      allowedInputTokens(100, {
        reservedOutputTokens: 60,
        framingReserveTokens: 30,
        safetyReserveTokens: 20,
      }),
    ).toBe(-10);
  });
});
