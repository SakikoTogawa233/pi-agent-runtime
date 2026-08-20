import { describe, expect, it } from "vitest";
import {
  allowedInputTokens,
  estimateInputTokens,
  knownTextSegment,
  maxKnownTextBytesForTokens,
  resolveTokenBudgetFamily,
  TOKEN_BUDGET_AFFINE_TOKENS,
  TOKEN_BUDGET_CALIBRATION_CORPUS_MIN_WHITESPACE_FRACTION_X10000,
  TOKEN_BUDGET_DENSE_ASCII_WHITESPACE_THRESHOLD_X10000,
  TOKEN_BUDGET_FAMILY_CALIBRATIONS,
  TOKEN_BUDGET_HAIRCUT_BASIS_POINTS,
  TOKEN_BUDGET_RATE_SCALE,
  unknownOutputContractSegment,
  utf8ByteClassBreakdown,
} from "../src/token-budget.js";

describe("token estimation", () => {
  it("pins the calibrated affine table and provenance guards", () => {
    expect(TOKEN_BUDGET_AFFINE_TOKENS).toBe(512);
    expect(TOKEN_BUDGET_HAIRCUT_BASIS_POINTS).toBe(1500);
    expect(TOKEN_BUDGET_FAMILY_CALIBRATIONS.anthropic).toMatchObject({
      rate_bytes_per_token_x100: 173,
      provenance: { n: 85, observed_min_bpt_x1000: 2047, backed: true },
    });
    expect(TOKEN_BUDGET_FAMILY_CALIBRATIONS["openai-codex"]).toMatchObject({
      rate_bytes_per_token_x100: 289,
      provenance: { n: 797, observed_min_bpt_x1000: 3400, backed: true },
    });
    expect(TOKEN_BUDGET_FAMILY_CALIBRATIONS.unknown).toMatchObject({
      rate_bytes_per_token_x100: 100,
      provenance: { n: 0, backed: false },
    });
    expect(TOKEN_BUDGET_DENSE_ASCII_WHITESPACE_THRESHOLD_X10000).toBeLessThan(
      TOKEN_BUDGET_CALIBRATION_CORPUS_MIN_WHITESPACE_FRACTION_X10000,
    );
  });

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
      familyResolution: "family_direct",
      segments: [knownTextSegment("a €"), unknownOutputContractSegment(100)],
    });
    expect(estimate.byte_class_breakdown).toEqual({
      total_bytes: 105,
      normal_bytes: 2,
      multibyte_bytes: 3,
      dense_bytes: 0,
      unknown_output_contract_bytes: 100,
    });
    expect(estimate.perSegment[0]?.multibyte_rate_bytes_per_token_x100).toBe(100);
    expect(estimate.tokens).toBe(617);
  });

  it("keeps segmentation invariant and freezes dense and multibyte forecasts", () => {
    const one = estimateInputTokens({
      family: "openai-codex",
      profile: "calibrated",
      allowedInputTokens: 231_040,
      calibrationBacked: true,
      familyResolution: "model_override",
      segments: [
        {
          kind: "known_text",
          bytes: 52_200,
          multibyteBytes: 0,
          denseBytes: 0,
          asciiWhitespaceBytes: 1_000,
        },
      ],
    });
    const two = estimateInputTokens({
      family: "openai-codex",
      profile: "calibrated",
      allowedInputTokens: 231_040,
      calibrationBacked: true,
      familyResolution: "model_override",
      segments: [
        {
          kind: "known_text",
          bytes: 26_100,
          multibyteBytes: 0,
          denseBytes: 0,
          asciiWhitespaceBytes: 500,
        },
        {
          kind: "known_text",
          bytes: 26_100,
          multibyteBytes: 0,
          denseBytes: 0,
          asciiWhitespaceBytes: 500,
        },
      ],
    });
    expect(one.rateSource.source).toBe("calibrated_large_window");
    expect(two.tokens).toBe(one.tokens);
    expect(two.rate_buckets).toEqual(one.rate_buckets);

    expect(() =>
      estimateInputTokens({
        family: "openai-codex",
        profile: "calibrated",
        allowedInputTokens: 231_040,
        calibrationBacked: true,
        familyResolution: "model_override",
        segments: [knownTextSegment("A".repeat(600_000))],
      }),
    ).toThrow(/calibrated.*dense|dense.*calibrated/i);
    const denseStrict = estimateInputTokens({
      family: "openai-codex",
      profile: "strict-runtime",
      allowedInputTokens: 231_040,
      calibrationBacked: true,
      familyResolution: "model_override",
      segments: [knownTextSegment("A".repeat(600_000))],
    });
    expect(denseStrict.tokens).toBe(600_512);
    expect(denseStrict.rateSource.source).toBe("strict_launch");

    const multibyte = estimateInputTokens({
      family: "openai-codex",
      profile: "calibrated",
      allowedInputTokens: 231_040,
      calibrationBacked: true,
      familyResolution: "model_override",
      segments: [
        {
          kind: "known_text",
          bytes: 100_000,
          multibyteBytes: 100_000,
          denseBytes: 0,
          asciiWhitespaceBytes: 0,
        },
      ],
    });
    expect(multibyte.tokens).toBe(50_512);
    expect(multibyte.advisory.input_tokens_if_multibyte_used_provable_ceiling).toBe(100_512);
  });

  it("uses the one-byte ceiling for multilingual and supplementary Unicode admission", () => {
    for (const profile of ["strict-launch", "strict-runtime", "provable"] as const) {
      const exact = estimateInputTokens({
        family: "openai-codex",
        profile,
        allowedInputTokens: 516,
        calibrationBacked: true,
        familyResolution: "model_override",
        segments: [knownTextSegment("😀")],
      });
      expect(exact.tokens, profile).toBe(516);
      expect(exact.perSegment[0]?.multibyte_rate_bytes_per_token_x100, profile).toBe(100);
      expect(
        estimateInputTokens({
          family: "openai-codex",
          profile,
          allowedInputTokens: 516,
          calibrationBacked: true,
          familyResolution: "model_override",
          segments: [knownTextSegment("😀a")],
        }).tokens,
        profile,
      ).toBe(517);
      expect(
        estimateInputTokens({
          family: "openai-codex",
          profile,
          allowedInputTokens: 522,
          calibrationBacked: true,
          familyResolution: "model_override",
          segments: [knownTextSegment("你好😀")],
        }).tokens,
        profile,
      ).toBe(522);
    }
  });

  it("keeps the strict-runtime affine boundary exact", () => {
    const allowedInputTokens = 100_000;
    const bytes = maxKnownTextBytesForTokens({
      family: "openai-codex",
      allowedInputTokens,
      profile: "strict-runtime",
      calibrationBacked: true,
      familyResolution: "model_override",
    });
    expect(bytes).toBe(99_488);
    const estimate = (size: number) =>
      estimateInputTokens({
        family: "openai-codex",
        profile: "strict-runtime",
        allowedInputTokens,
        calibrationBacked: true,
        familyResolution: "model_override",
        segments: [knownTextSegment("x".repeat(size))],
      }).tokens;
    expect(estimate(bytes)).toBe(allowedInputTokens);
    expect(estimate(bytes + 1)).toBe(allowedInputTokens + 1);
  });

  it("derives calibrated text capacity without a synthetic zero-byte admission failure", () => {
    for (const family of ["anthropic", "openai-codex"] as const) {
      const allowedInputTokens = 231_040;
      const calibration = TOKEN_BUDGET_FAMILY_CALIBRATIONS[family];
      const bytes = maxKnownTextBytesForTokens({
        family,
        allowedInputTokens,
        profile: "calibrated",
        calibrationBacked: true,
        familyResolution: "model_override",
      });
      expect(bytes).toBe(
        Math.floor(
          ((allowedInputTokens - calibration.affine_f_tokens) *
            calibration.rate_bytes_per_token_x100) /
            TOKEN_BUDGET_RATE_SCALE,
        ),
      );
      const estimate = (size: number) =>
        estimateInputTokens({
          family,
          profile: "calibrated",
          allowedInputTokens,
          calibrationBacked: true,
          familyResolution: "model_override",
          segments: [
            {
              kind: "known_text",
              bytes: size,
              multibyteBytes: 0,
              denseBytes: 0,
              asciiWhitespaceBytes: 1_000,
            },
          ],
        }).tokens;
      expect(estimate(bytes), family).toBe(allowedInputTokens);
      expect(estimate(bytes + 1), family).toBe(allowedInputTokens + 1);
    }
  });

  it("resolves only the frozen backed model set and fails malformed arithmetic loudly", () => {
    expect(
      resolveTokenBudgetFamily({ provider: "anthropic", model: "claude-opus-5" }),
    ).toMatchObject({
      family: "anthropic",
      backed: true,
      resolution: "model_override",
    });
    expect(() =>
      resolveTokenBudgetFamily({ provider: "anthropic", model: "unknown-model" }),
    ).toThrow(/no calibrated token family/i);
    expect(() =>
      estimateInputTokens({
        family: "openai-codex",
        profile: "calibrated",
        allowedInputTokens: 100_000,
        calibrationBacked: false,
        familyResolution: "model_override",
        segments: [knownTextSegment("word ".repeat(20_000))],
      }),
    ).toThrow(/calibrated.*backing/i);
    expect(() =>
      estimateInputTokens({
        family: "openai-codex",
        profile: "calibrated",
        allowedInputTokens: 100_000,
        calibrationBacked: true,
        familyResolution: "model_override",
        segments: [knownTextSegment("small prompt")],
      }),
    ).toThrow(/calibrated.*minimum/i);
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
