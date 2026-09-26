import process from "node:process";

export type LLMProvider = "openai" | "openrouter" | "ollama" | "groq" | "gemini";

export const supportedProviders = new Set<LLMProvider>([
  "openai",
  "openrouter",
  "ollama",
  "groq",
  "gemini",
]);

export function resolveLlmProvider(value: string | undefined): LLMProvider {
  return value && supportedProviders.has(value as LLMProvider)
    ? (value as LLMProvider)
    : "openrouter";
}

export function logProvider(provider: LLMProvider): void {
  if (provider === "openai") {
    console.log("[LLM] Using OpenAI:", process.env.OPENAI_MODEL ?? "gpt-5.6-terra");
  } else if (provider === "ollama") {
    console.log("[LLM] Using local Ollama:", process.env.OLLAMA_MODEL ?? "qwen2.5-coder:3b");
  } else if (provider === "groq") {
    console.log("[LLM] Using Groq:", process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile");
  } else if (provider === "gemini") {
    console.log(
      "[LLM] Using Gemini:",
      process.env.GOOGLE_API_KEY ? "Configured" : "Not configured",
    );
  } else {
    console.log("[LLM] Using OpenRouter:", process.env.OPENROUTER_MODEL ?? "openrouter/free");
  }
}

export function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const record = error as Record<string, unknown>;

  const response = record.response;

  if (typeof response === "object" && response !== null) {
    const status = (response as Record<string, unknown>).status;

    if (typeof status === "number") {
      return status;
    }
  }

  const status = record.status;

  if (typeof status === "number") {
    return status;
  }

  return undefined;
}

export function isProviderFallbackError(error: unknown): boolean {
  const status = getErrorStatus(error);

  // 429 = rate limit / quota
  // 402 = insufficient credits/payment required
  if (status === 429 || status === 402) {
    return true;
  }

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  return (
    message.includes("rate limit") ||
    message.includes("quota") ||
    message.includes("too many requests") ||
    message.includes("insufficient credits") ||
    message.includes("credits exhausted")
  );
}

export function contentToString(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  return JSON.stringify(content);
}
