import type OpenAI from "openai"

export type TokenCounts = {
  input: number
  input_cache_hit?: number
  output: number
}

/** Provider-neutral reasoning intent. Adapters resolve this to their native setting. */
export type ThinkLevel = "on" | "high" | "off"

/** `default` explicitly clears sticky reasoning intent; undefined inherits it. */
export type ThinkOverride = ThinkLevel | "default" | undefined

export function resolveThink(
  override: ThinkOverride,
  inherited: ThinkLevel | undefined,
): ThinkLevel | undefined {
  if (override === undefined) return inherited
  return override === "default" ? undefined : override
}

type UserMessage = {
  role: "user"
  content: string
  createdAt: Date
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
  createdAt: Date
  /** Model response text */
  content: string
  /** Reasoning text. May be blank. Not rendered in --raw mode. */
  reasoning?: string
  /** Provider-native reasoning setting used for this request. */
  effort?: string
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
  /** Last-used web search setting. Inherited by `-r` replies (unless overridden
   * with -s/--no-search) so search stays on across a chat and prompt caching
   * keeps hitting. All providers cache on a request prefix that includes the
   * tool definitions, so toggling the search tool busts the cache — most
   * severely on Anthropic, where tools sit at the front of the prefix
   * (tools → system → messages) and re-sending the full history re-pays for
   * everything after. */
  search?: boolean
  /** Last provider-neutral reasoning intent. Inherited by replies. */
  think?: ThinkLevel
  background?: {
    id: string // OpenAI response.id for polling
    status: BackgroundStatus
    startedAt: Date // when request was initiated
    provider: "openai" // future-proof for other providers
    modelId: string
    effort?: string
  }
}
