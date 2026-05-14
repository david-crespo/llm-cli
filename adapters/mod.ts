import { ValidationError } from "@cliffy/command"

import type { ChatInput, ModelResponse, ToolConfig } from "./types.ts"
import {
  cerebrasCreateMessage,
  deepseekCreateMessage,
  gptCreateMessage,
  grokCreateMessage,
  groqCreateMessage,
  openrouterCreateMessage,
} from "./openai.ts"
import { claudeCreateMessage } from "./claude.ts"
import { geminiCreateMessage } from "./gemini.ts"

export type { ChatInput, ModelResponse, ThinkLevel, ToolConfig } from "./types.ts"
export { gptBg } from "./openai.ts"

export const searchProviders = new Set(["anthropic", "openai", "google"])
export const thinkProviders = new Set(["anthropic", "openai", "google"])
export const imageProviders = new Set(["anthropic", "openai", "google"])

export function validateConfig(provider: string, config: ToolConfig) {
  if (config.search && !searchProviders.has(provider)) {
    throw new ValidationError(`Search not supported for ${provider}`)
  }
  if (config.think !== undefined && !thinkProviders.has(provider)) {
    throw new ValidationError(`Thinking control not supported for ${provider}`)
  }
}

export function createMessage(input: ChatInput): Promise<ModelResponse> {
  const { provider } = input.model
  if (provider === "anthropic") return claudeCreateMessage(input)
  if (provider === "google") return geminiCreateMessage(input)
  if (provider === "deepseek") return deepseekCreateMessage(input)
  if (provider === "cerebras") return cerebrasCreateMessage(input)
  if (provider === "groq") return groqCreateMessage(input)
  if (provider === "xai") return grokCreateMessage(input)
  if (provider === "openrouter") return openrouterCreateMessage(input)
  return gptCreateMessage(input)
}
