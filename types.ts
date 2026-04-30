import type OpenAI from "openai"

export type TokenCounts = {
  input: number
  input_cache_hit?: number
  output: number
}

type UserMessage = {
  role: "user"
  content: string
  image_url?: string
  cache?: boolean
  /** arktype canonical expression of the requested output schema, if any */
  outputSchema?: string
}

/** Provider-specific assistant-message data. Discriminated on `type` so we
 * can add fields for other providers without widening every consumer. */
export type ProviderData = {
  type: "openai"
  /** Responses API response.id, used as previous_response_id on the next turn
   * so reasoning items carry over and prompt caching hits. */
  responseId: string
}

type AssistantMessage = {
  role: "assistant"
  model: string
  /** Model response text */
  content: string
  /** Reasoning text. May be blank. Not rendered in --raw mode. */
  reasoning?: string
  tokens: TokenCounts
  stop_reason: string
  cost: number
  timeMs: number
  cache?: boolean
  searches?: number
  provider?: ProviderData
}

export type ChatMessage = UserMessage | AssistantMessage

export type BackgroundStatus = OpenAI.Responses.ResponseStatus

export type Chat = {
  /** Stable per-chat ID. Used as OpenAI prompt_cache_key for reliable cache
   * routing across turns. */
  id: string
  // For now we don't allow system prompt to be changed in the middle
  // of a chat. Otherwise we'd have to annotate each message with it.
  systemPrompt: string
  messages: ChatMessage[]
  createdAt: Date
  summary?: string
  background?: {
    id: string // OpenAI response.id for polling
    status: BackgroundStatus
    startedAt: Date // when request was initiated
    provider: "openai" // future-proof for other providers
    modelId: string
  }
}
