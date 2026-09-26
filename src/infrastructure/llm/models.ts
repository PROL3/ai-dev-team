import "dotenv/config";
import process from "node:process";
import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGroq } from "@langchain/groq";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

export const openRouterModel = new ChatOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  model: process.env.OPENROUTER_MODEL ?? "openrouter/free",
  temperature: 0,
  configuration: {
    baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",

    defaultHeaders: {
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost",
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "AI Dev Team",
    },
  },
});

export const openAIModel = new ChatOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL ?? "gpt-5.6-terra",
  temperature: 0,
});

export const ollamaModel = new ChatOllama({
  baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",

  model: process.env.OLLAMA_MODEL ?? "qwen2.5-coder:3b",

  temperature: 0,
  format: "json",
});

export const groqModel = new ChatGroq({
  ...(process.env.GROQ_API_KEY ? { apiKey: process.env.GROQ_API_KEY } : {}),
  model: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
  temperature: 0,
});

export const geminiModel = new ChatGoogleGenerativeAI({
  model: process.env.GEMINI_MODEL ?? "gemini-3.8-flash",
  ...(process.env.GOOGLE_API_KEY ? { apiKey: process.env.GOOGLE_API_KEY } : {}),
  temperature: 0,
});
