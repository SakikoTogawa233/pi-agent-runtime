import { readFileSync } from "node:fs";
import {
  buildSessionContext,
  convertToLlm,
  type ExtensionFactory,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { anthropicAttributionExtension } from "../src/anthropic-attribution.js";
import { observeModelRegistryOAuth } from "../src/oauth.js";

describe("ModelRegistry OAuth observation", () => {
  it("returns the exact selected model only when registry OAuth is active", () => {
    const model = { provider: "anthropic", id: "claude-opus-5", api: "anthropic-messages" };
    const registry = {
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
      isUsingOAuth: (candidate: unknown) => candidate === model,
    };
    expect(observeModelRegistryOAuth(registry, "anthropic", "claude-opus-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-5",
      api: "anthropic-messages",
      selectedModel: model,
    });
  });

  it("passes slash-containing model ids to the registry without splitting them", () => {
    const selected = { provider: "anthropic", id: "claude/opus", api: "anthropic-messages" };
    const find = vi.fn(() => selected);
    expect(
      observeModelRegistryOAuth({ find, isUsingOAuth: () => true }, "anthropic", "claude/opus"),
    ).toMatchObject({ provider: "anthropic", modelId: "claude/opus", selectedModel: selected });
    expect(find).toHaveBeenCalledWith("anthropic", "claude/opus");
  });

  it("fails loudly for missing models, unavailable observation, and non-OAuth routes", () => {
    expect(() =>
      observeModelRegistryOAuth({ find: () => undefined, isUsingOAuth: () => true }, "x", "y"),
    ).toThrow(/not found/);
    const model = { provider: "x", id: "y", api: "test-api" };
    expect(() => observeModelRegistryOAuth({ find: () => model }, "x", "y")).toThrow(/unavailable/);
    expect(() =>
      observeModelRegistryOAuth({ find: () => model, isUsingOAuth: () => false }, "x", "y"),
    ).toThrow(/requires OAuth/);
  });
});

describe("installed Pi 0.84.2 compatibility characterization", () => {
  it("proves the required host exports and hook/model interfaces from the installed package", () => {
    const packageJson = JSON.parse(
      readFileSync(
        new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url),
        "utf8",
      ),
    ) as { version: string };
    expect(packageJson.version).toBe("0.84.2");
    expect(typeof ModelRegistry.prototype.find).toBe("function");
    expect(typeof ModelRegistry.prototype.isUsingOAuth).toBe("function");
    expect(typeof buildSessionContext).toBe("function");
    expect(typeof convertToLlm).toBe("function");
    const childAttributionFactory: ExtensionFactory = anthropicAttributionExtension;
    expect(typeof childAttributionFactory).toBe("function");
    const session = SessionManager.inMemory("/tmp/runtime-compat");
    session.appendMessage({ role: "user", content: "compat", timestamp: 1 });
    const context = buildSessionContext(session.getEntries(), session.getLeafId());
    expect(convertToLlm(context.messages)).toHaveLength(1);
  });
});
