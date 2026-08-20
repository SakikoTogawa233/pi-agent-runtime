import { createRequire } from "node:module";
import {
  ModelRegistry,
  SessionManager,
  buildSessionContext,
  convertToLlm,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { observeModelRegistryOAuth } from "../src/oauth.js";

const require = createRequire(import.meta.url);

describe("ModelRegistry OAuth observation", () => {
  it("returns the exact selected model only when registry OAuth is active", () => {
    const model = { provider: "anthropic", id: "claude-opus-5", api: "anthropic-messages" };
    const registry = {
      find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
      isUsingOAuth: (candidate: unknown) => candidate === model,
    };
    expect(observeModelRegistryOAuth(registry, "anthropic", "claude-opus-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-5",
      api: "anthropic-messages",
      selectedModel: model,
    });
  });

  it("fails loudly for missing models, unavailable observation, and non-OAuth routes", () => {
    expect(() =>
      observeModelRegistryOAuth({ find: () => undefined, isUsingOAuth: () => true }, "x", "y"),
    ).toThrow(/not found/);
    expect(() => observeModelRegistryOAuth({ find: () => ({}) }, "x", "y")).toThrow(/unavailable/);
    expect(() =>
      observeModelRegistryOAuth({ find: () => ({}), isUsingOAuth: () => false }, "x", "y"),
    ).toThrow(/requires OAuth/);
  });
});

describe("installed Pi 0.84.2 compatibility characterization", () => {
  it("proves the required host exports and hook/model interfaces from the installed package", () => {
    const packageJson = require("@earendil-works/pi-coding-agent/package.json") as { version: string };
    expect(packageJson.version).toBe("0.84.2");
    expect(typeof ModelRegistry.prototype.find).toBe("function");
    expect(typeof ModelRegistry.prototype.isUsingOAuth).toBe("function");
    expect(typeof buildSessionContext).toBe("function");
    expect(typeof convertToLlm).toBe("function");
    const session = SessionManager.inMemory("/tmp/runtime-compat");
    session.appendMessage({ role: "user", content: "compat", timestamp: 1 });
    const context = buildSessionContext(session.getEntries(), session.getLeafId());
    expect(convertToLlm(context.messages)).toHaveLength(1);
  });
});
