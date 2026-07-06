import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS, presetFor } from "./providerCatalog";

describe("providerCatalog", () => {
  it("exposes exactly the four engine provider kinds", () => {
    expect(PROVIDER_PRESETS.map((p) => p.kind).sort()).toEqual(
      ["deepseek", "moonshot", "openai-compatible", "zai"],
    );
  });

  it("omits DeepSeek's retiring aliases from the model list", () => {
    const models = presetFor("deepseek").models;
    expect(models).toContain("deepseek-v4-flash");
    expect(models).toContain("deepseek-v4-pro");
    expect(models).not.toContain("deepseek-chat");
    expect(models).not.toContain("deepseek-reasoner");
  });

  it("marks base URL required for openai-compatible and hidden for deepseek", () => {
    expect(presetFor("openai-compatible").baseURLRequired).toBe(true);
    expect(presetFor("deepseek").baseURLHidden).toBe(true);
  });

  it("prefills default base URLs for moonshot and zai", () => {
    expect(presetFor("moonshot").defaultBaseURL).toBe("https://api.moonshot.ai/v1");
    expect(presetFor("zai").defaultBaseURL).toBe("https://api.z.ai/api/paas/v4");
  });
});
