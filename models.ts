import { ValidationError } from "jsr:@cliffy/command@1.0.0-rc.7"
import { type TokenCounts } from "./types.ts"

// prices are per million tokens
type ModelConfig = {
  provider: string
  key: string
  nickname: string
  input: number
  output: number
  input_cached?: number
}

export const defaultModel = "claude-3-5-sonnet-latest"

/**
 * The order matters: preferred models go first.
 *
 * We pick a model by finding the first one containing the specified string.
 * But the same string can be in multiple model names. For example, "mini" is
 * in both gpt-4o-mini and the gemini models. By putting gpt-4o-mini earlier, we
 * ensure "mini" matches that. By putting gpt-4o first, we ensure "4o" matches
 * that.
 */
export const models: ModelConfig[] = [
  {
    provider: "anthropic",
    key: "claude-3-5-sonnet-latest",
    nickname: "sonnet",
    input: 3,
    output: 15,
  },
  {
    provider: "anthropic",
    key: "claude-3-5-haiku-latest",
    nickname: "haiku",
    input: 1,
    output: 5,
  },
  {
    provider: "openai",
    key: "chatgpt-4o-latest",
    nickname: "gpt-4o",
    input: 2.5,
    input_cached: 1.25,
    output: 10,
  },
  {
    provider: "openai",
    key: "gpt-4o-mini",
    nickname: "gpt-4o-mini",
    input: .15,
    input_cached: 0.075,
    output: .6,
  },
  {
    provider: "openai",
    key: "o1-mini",
    nickname: "o1-mini",
    input: 3,
    input_cached: 1.5,
    output: 12,
  },
  {
    provider: "openai",
    key: "o1-preview",
    nickname: "o1",
    input: 15,
    input_cached: 7.5,
    output: 60,
  },
  {
    provider: "google",
    key: "gemini-exp-1206",
    nickname: "gemini-exp",
    // >128k: 5 / 10
    input: 1.25,
    output: 2.50,
  },
  {
    provider: "google",
    key: "gemini-2.0-flash-exp",
    nickname: "flash",
    // >128k: 0.15 / 0.60
    input: .075,
    output: .3,
  },
  {
    provider: "google",
    key: "gemini-2.0-flash-thinking-exp",
    nickname: "flash-thinking",
    input: .35,
    output: 1.5,
  }, // estimated
  {
    provider: "deepseek",
    key: "deepseek-chat",
    nickname: "deepseek-v3",
    input: 0.14,
    input_cached: 0.014,
    output: 0.28,
  },
  {
    provider: "deepseek",
    key: "deepseek-reasoner",
    nickname: "deepseek-r1",
    input: 0.55,
    input_cached: 0.14,
    output: 2.19,
  },
  {
    provider: "groq",
    key: "llama-3.3-70b-versatile",
    nickname: "groq-llama",
    input: .59,
    output: 0.79,
  },
  // no price online so assume same as llama-70b for now
  {
    provider: "groq",
    key: "deepseek-r1-distill-llama-70b",
    nickname: "groq-r1-llama",
    input: .59,
    output: 0.79,
  },
  // technically free until they set up their paid tier but whatever
  {
    provider: "cerebras",
    key: "llama-3.3-70b",
    nickname: "cerebras-llama",
    input: 0.85,
    output: 1.20,
  },
]

/** Errors and exits if it can't resolve to a model */
export function resolveModel(modelArg: string | undefined): string {
  if (modelArg === undefined) return defaultModel

  // Find the first model containing the arg as a substring. See comment at
  // allModels definition about ordering.
  const lower = modelArg.toLowerCase()
  const match = models.find((m) => m.key.includes(lower) || m.nickname.includes(lower))

  if (!match) {
    // TODO: print list of models as part of this error, not just the help. or
    // throw here
    throw new ValidationError(
      `Model '${modelArg}' not found. Use the models command to list models.`,
    )
  }

  return match.key
}

const M = 1_000_000

export function getCost(modelKey: string, tokens: TokenCounts) {
  const model = models.find((m) => m.key === modelKey)
  // this shouldn't happen
  if (!model) throw new Error(`Model with key '${modelKey}' not found`)
  const { input, output, input_cached } = model

  // when there is caching and we have cache pricing, take it into account
  const cost = input_cached && tokens.input_cache_hit
    ? (input_cached * tokens.input_cache_hit) +
      (input * (tokens.input - tokens.input_cache_hit)) + (output * tokens.output)
    : (input * tokens.input) + (output * tokens.output)

  // Gemini models have double pricing over 128k https://ai.google.dev/pricing
  if (modelKey.includes("gemini") && tokens.input > 128_000) return 2 * cost / M

  return cost / M
}
