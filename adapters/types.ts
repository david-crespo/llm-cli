import type { Type } from "arktype"

import type { Chat, TokenCounts } from "../types.ts"
import type { Model } from "../models.ts"

export type ModelResponse = {
  content: string
  tokens: TokenCounts
  stop_reason: string
  cost: number
  searches?: number
}

export type ThinkLevel = "on" | "high" | "off" | undefined

export type ToolConfig = {
  search: boolean
  think: ThinkLevel
}

export type ChatInput = {
  chat: Chat
  model: Model
  config: ToolConfig
  signal?: AbortSignal
  outputSchema?: Type
}
