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

export type ImageTurn = {
  prompt: string
  /** Images attached on this turn (`-i/--image`), as data or HTTP(S) URLs */
  imageUrls: string[]
  /** Saved image paths from the most recent assistant image turn, empty on a fresh chat */
  previousImages: string[]
}

/**
 * Resolve the current user prompt and prior image context for an image model.
 * Replies require a previous generated image in the chat.
 */
export function imagePrompt(chat: Chat): ImageTurn {
  const message = chat.messages.at(-1)
  if (message?.role !== "user" || !message.content.trim()) {
    throw new ValidationError("Image models require a prompt with text")
  }
  if (chat.messages.length === 1) {
    return {
      prompt: message.content,
      imageUrls: message.image_urls ?? [],
      previousImages: [],
    }
  }
  const prior = chat.messages.slice(0, -1)
  const lastImageTurn = prior.findLast((m) => m.role === "assistant" && m.images?.length)
  if (
    !lastImageTurn ||
    lastImageTurn.role !== "assistant" ||
    !lastImageTurn.images?.length
  ) {
    throw new ValidationError("Can't reply with an image model: chat has no previous image")
  }
  return {
    prompt: message.content,
    imageUrls: message.image_urls ?? [],
    previousImages: lastImageTurn.images,
  }
}
