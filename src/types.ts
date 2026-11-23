import type OpenAI from "openai"

export type TokenCounts = {
  input: number
  input_cache_hit?: number
  /** Tokens written to the prompt cache this turn (Anthropic only). Subset of `input`. */
  input_cache_write?: number
  output: number
  /** Image tokens in the output (image models only). Subset of `output`. */
  output_image?: number
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
  image_urls?: string[]
  cache?: boolean
  /** arktype canonical expression of the requested output schema, if any */
  outputSchema?: string
}

/** Provider-specific assistant-message data. Discriminated on `type` so we
 * can add fields for other providers without widening every consumer. */
export type ProviderData =
  | {
      type: "openai"
      /** Responses API response.id, used as previous_response_id on the next turn
       * so reasoning items carry over and prompt caching hits. */
      responseId: string
    }
  | {
      type: "google"
      /** Interactions API interaction.id, used as previous_interaction_id on
       * the next turn so multi-turn image state carries over. */
      interactionId: string
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
  /** Paths of generated images saved to disk (image models only) */
  images?: string[]
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
  /**
   * Last-used web search setting, inherited by `-r` replies unless overridden
   * with `-s` or `--no-search`. Every provider's prompt cache prefix includes
   * tool definitions (before `system` and `messages` on Anthropic), so keeping
   * the search tool stable across turns preserves cache hits.
   */
  search?: boolean
  /** Last provider-neutral reasoning intent. Inherited by replies. */
  think?: ThinkLevel
  /** API key profile the chat was started or last explicitly continued with.
   * Replies use it so they bill the same account, and OpenAI background
   * responses can only be retrieved with the key that created them. */
  profile?: string
  background?: {
    id: string // OpenAI response.id for polling
    status: BackgroundStatus
    startedAt: Date // when request was initiated
    provider: "openai" // future-proof for other providers
    modelId: string
    effort?: string
  }
}
