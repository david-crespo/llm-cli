import { type Model } from "./models.ts"

export type TokenCounts = {
  input: number
  input_cache_hit?: number
  output: number
}

type AssistantMessage = {
  role: "assistant"
  model: Model
  content: string
  tokens: TokenCounts
  stop_reason: string
  cost: number
  timeMs: number
}
type UserMessage = { role: "user"; content: string }
export type ChatMessage = UserMessage | AssistantMessage

export const isAssistant = (m: ChatMessage): m is AssistantMessage => m.role === "assistant"

export type Chat = {
  // For now we don't allow system prompt to be changed in the middle
  // of a chat. Otherwise we'd have to annotate each message with it.
  systemPrompt: string | undefined
  messages: ChatMessage[]
  createdAt: string
  summary?: string
}
