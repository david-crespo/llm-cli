import type { Type } from "arktype"

import type { Chat, ProviderData, ThinkLevel, TokenCounts } from "../types.ts"
import type { Model } from "../models.ts"

export type ModelResponse = {
  content: string
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
  config: ToolConfig
  signal?: AbortSignal
  outputSchema?: Type
  imageOptions?: ImageOptions
}

export const imageQualities = ["low", "medium", "high", "xhigh", "max", "auto"] as const

export type ImageOptions = {
  quality?: typeof imageQualities[number]
  /** `WIDTHxHEIGHT` or `auto` */
  size?: string
}
