import { ValidationError } from "jsr:@cliffy/command@1.0.0-rc.7"
import { type TokenCounts } from "./types.ts"

// prices are per million tokens
type Model = {
  provider: string
  key: string
  id: string
  input: number
  output: number
  input_cached?: number
  default?: true
}

/**
 * The order matters: preferred models go first.
 *
 * We pick a model by finding the first one containing the specified string.
 * But the same string can be in multiple model names. For example, "mini" is
 * in both gpt-4o-mini and the gemini models. By putting gpt-4o-mini earlier, we
 * ensure "mini" matches that. By putting gpt-4o first, we ensure "4o" matches
 * that.
 *
 * id is doing double duty as both a human-readable nickname and a unique ID.
 */
export const models: Model[] = [
  {
    provider: "anthropic",
    key: "claude-3-7-sonnet-latest",
    id: "sonnet",
    input: 3,
    input_cached: 0.3,
    output: 15,
    default: true,
  },
  {
    provider: "anthropic",
    key: "claude-3-5-haiku-latest",
    id: "haiku",
    input: 0.8,
    input_cached: 0.08,
    output: 4,
  },
  {
    provider: "openai",
    key: "chatgpt-4o-latest",
    id: "gpt-4o",
    input: 5,
    input_cached: 2.50,
    output: 15,
  },
  {
    provider: "openai",
    key: "gpt-4o-mini",
    id: "gpt-4o-mini",
    input: .15,
    input_cached: 0.075,
    output: .6,
  },
  {
    provider: "openai",
    key: "gpt-4.5-preview",
    id: "gpt-4.5",
    input: 75,
    input_cached: 37.50,
    output: 150,
  },
  {
    provider: "openai",
    key: "o1-mini",
    id: "o1-mini",
    input: 3,
    input_cached: 1.5,
    output: 12,
  },
  {
    provider: "openai",
    key: "o1-preview",
    id: "o1",
    input: 15,
    input_cached: 7.5,
    output: 60,
  },
  {
    provider: "google",
    key: "gemini-2.0-pro-exp",
    id: "gemini-pro",
    input: 1.25,
    output: 2.50,
  },
  {
    provider: "google",
    key: "gemini-2.0-flash",
    id: "flash",
    input: .10,
    output: .40,
  },
  {
    provider: "google",
    key: "gemini-2.0-flash-thinking-exp",
    id: "flash-thinking",
    // estimated
    input: .35,
    output: 1.50,
  },
  {
    provider: "deepseek",
    key: "deepseek-chat",
    id: "deepseek-v3",
    input: 0.14,
    input_cached: 0.014,
    output: 0.28,
  },
  {
    provider: "deepseek",
    key: "deepseek-reasoner",
    id: "deepseek-r1",
    input: 0.55,
    input_cached: 0.14,
    output: 2.19,
  },
  {
    provider: "groq",
    key: "llama-3.3-70b-versatile",
    id: "groq-llama",
    input: .59,
    output: 0.79,
  },
  // no price online so assume same as llama-70b for now
  {
    provider: "groq",
    key: "deepseek-r1-distill-llama-70b",
    id: "groq-r1-llama",
    input: .59,
    output: 0.79,
  },
  // technically free until they set up their paid tier but whatever
  {
    provider: "cerebras",
    key: "llama-3.3-70b",
    id: "cerebras-llama",
    input: 0.85,
    output: 1.20,
  },
]

/** Errors and exits if it can't resolve to a model */
export function resolveModel(modelArg: string | undefined) {
  if (modelArg === undefined) return models.find((m) => m.default)!

  // Find the first model containing the arg as a substring. See comment at
  // allModels definition about ordering.
  const lower = modelArg.toLowerCase()
  const match = models.find((m) => m.key.includes(lower) || m.id.includes(lower))

  if (!match) {
    // TODO: print list of models as part of this error, not just the help. or
    // throw here
    throw new ValidationError(
      `Model '${modelArg}' not found. Use the models command to list models.`,
    )
  }

  return match
}

const M = 1_000_000

export function getCost(model: Model, tokens: TokenCounts) {
  const { input, output, input_cached } = model

  // when there is caching and we have cache pricing, take it into account
  const cost = input_cached && tokens.input_cache_hit
    ? (input_cached * tokens.input_cache_hit) +
      (input * (tokens.input - tokens.input_cache_hit)) + (output * tokens.output)
    : (input * tokens.input) + (output * tokens.output)

  // Gemini models have double pricing over 128k https://ai.google.dev/pricing
  if (model.provider === "google" && tokens.input > 128_000) return 2 * cost / M

  return cost / M
}

export const systemBase =
  `Answer the question precisely, without much elaboration. When asked for code, only output code: do not explain unless asked to. Your answers must be in markdown format.

Here is some information about the user
- macOS user
- Terminal: Ghostty
- Text editor: Helix
- Shell: zsh
- Software engineer who mostly uses TypeScript and Rust
- Preference for elegant terminal one-liners
`
