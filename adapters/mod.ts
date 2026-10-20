import type { ChatInput, ModelResponse } from "./types.ts"
import {
  gptCreateMessage,
  gptImageCreateMessage,
  openrouterCreateMessage,
} from "./openai.ts"
import { claudeCreateMessage } from "./claude.ts"
import { geminiCreateMessage } from "./gemini.ts"

export type { ChatInput, ImageOptions, ModelResponse, ToolConfig } from "./types.ts"
export { imageQualities } from "./types.ts"
export type { ThinkLevel } from "../types.ts"
export { gptBg } from "./openai.ts"

export const searchProviders = new Set(["anthropic", "openai", "google"])
export const thinkProviders = new Set(["anthropic", "openai", "google", "baseten"])
export const imageInputProviders = new Set(["anthropic", "openai", "google"])

export function createMessage(input: ChatInput): Promise<ModelResponse> {
  const { provider } = input.model
  if (input.model.kind === "image") return gptImageCreateMessage(input)
  if (provider === "anthropic") return claudeCreateMessage(input)
  if (provider === "google") return geminiCreateMessage(input)
  if (provider === "openrouter") return openrouterCreateMessage(input)
  return gptCreateMessage(input)
}
