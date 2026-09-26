import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveLlmProvider } from "../../src/infrastructure/llm/gateway.js";

test("selects the direct OpenAI provider when requested", () => {
  assert.equal(resolveLlmProvider("openai"), "openai");
});

test("keeps each existing provider and defaults invalid values to OpenRouter", () => {
  for (const provider of ["openrouter", "ollama", "groq", "gemini"]) {
    assert.equal(resolveLlmProvider(provider), provider);
  }
  assert.equal(resolveLlmProvider(undefined), "openrouter");
  assert.equal(resolveLlmProvider("gpt-5.6-terra"), "openrouter");
});
