import "dotenv/config";
import process from "node:process";
import { openRouterModel, openAIModel, ollamaModel, groqModel, geminiModel } from "./models.js";
import {
  resolveLlmProvider,
  logProvider,
  isProviderFallbackError,
  contentToString,
} from "./provider.js";

export let activeProvider = resolveLlmProvider(process.env.LLM_PROVIDER);

export let fallbackLogged = false;

export async function askLLM(prompt: string): Promise<string> {
  if (activeProvider === "ollama") {
    if (!fallbackLogged) {
      logProvider("ollama");
      fallbackLogged = true;
    }

    const response = await ollamaModel.invoke(prompt);
    return contentToString(response.content);
  }

  if (activeProvider === "groq") {
    logProvider("groq");

    try {
      const response = await groqModel.invoke(prompt);
      return contentToString(response.content);
    } catch (error) {
      if (!isProviderFallbackError(error)) {
        throw error;
      }

      activeProvider = "ollama";
      console.warn("\n[LLM] Groq limit/quota reached.");
      console.warn("[LLM] Falling back to local Ollama.");
      fallbackLogged = true;

      const response = await ollamaModel.invoke(prompt);
      return contentToString(response.content);
    }
  }
  if (activeProvider === "gemini") {
    logProvider("gemini");

    try {
      const response = await geminiModel.invoke(prompt);
      return contentToString(response.content);
    } catch (error) {
      if (!isProviderFallbackError(error)) {
        throw error;
      }

      activeProvider = "ollama";
      console.warn("\n[LLM] Gemini limit/quota reached.");
      console.warn("[LLM] Falling back to local Ollama.");
      fallbackLogged = true;

      const response = await ollamaModel.invoke(prompt);
      return contentToString(response.content);
    }
  }

  if (activeProvider === "openai") {
    logProvider("openai");

    try {
      const response = await openAIModel.invoke(prompt);
      return contentToString(response.content);
    } catch (error) {
      if (!isProviderFallbackError(error)) {
        throw error;
      }

      activeProvider = "ollama";
      console.warn("\n[LLM] OpenAI limit/quota reached.");
      console.warn("[LLM] Falling back to local Ollama.");
      fallbackLogged = true;

      const response = await ollamaModel.invoke(prompt);
      return contentToString(response.content);
    }
  }

  try {
    logProvider("openrouter");

    const response = await openRouterModel.invoke(prompt);

    return contentToString(response.content);
  } catch (error) {
    if (!isProviderFallbackError(error)) {
      throw error;
    }

    activeProvider = "ollama";

    console.warn("\n[LLM] OpenRouter limit/quota reached.");

    console.warn("[LLM] Disabling OpenRouter for this process.");
    console.warn(
      "[LLM] Falling back to local Ollama:",
      process.env.OLLAMA_MODEL ?? "qwen2.5-coder:3b",
    );
    fallbackLogged = true;

    const response = await ollamaModel.invoke(prompt);

    return contentToString(response.content);
  }
}

export { resolveLlmProvider, type LLMProvider } from "./provider.js";
