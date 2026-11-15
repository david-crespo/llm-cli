import type { Type } from "arktype"

import { ValidationError } from "../errors.ts"

import type { Chat, ProviderData, ThinkLevel, TokenCounts } from "../types.ts"
import type { Model } from "../models.ts"

export type ModelResponse = {
  content: string
  reasoning?: string
  tokens: TokenCounts
  stop_reason: string
  cost: number
  searches?: number
  effort?: string
  provider?: ProviderData
  images?: string[]
}

export type ToolConfig = {
  search: boolean
  think: ThinkLevel | undefined
}

export type ChatInput = {
  chat: Chat
  model: Model
  apiKey: string
  config: ToolConfig
  signal?: AbortSignal
  outputSchema?: Type
  imageOptions?: ImageOptions
}

export const imageQualities = ["low", "medium", "high", "xhigh", "max", "auto"] as const

export type ImageOptions = {
  quality?: (typeof imageQualities)[number]
  /** OpenAI: `WIDTHxHEIGHT` or `auto`. Gemini: `1K`, `2K`, or `4K`. */
  size?: string
  /** `W:H`, Gemini only */
  aspect?: string
}

/** Image generation currently accepts only a fresh text prompt. */
export function imagePrompt(chat: Chat): string {
  const [message] = chat.messages
  if (
    chat.messages.length !== 1 ||
    message?.role !== "user" ||
    message.image_urls?.length
  ) {
    throw new ValidationError("Image generation requires a fresh text-only prompt")
  }
  return message.content
}
