import { ValidationError } from "@cliffy/command"
import { type TokenCounts } from "./types.ts"
import $ from "@david/dax"

// prices are per million tokens
export type Model = {
  provider: string
  /** Key provided to API call */
  key: string
  /** ID for display and usability purposes */
  id: string
  default?: true
  // prices
  input: number
  output: number
  input_cached?: number
  /** Cost per web search in dollars */
  search_cost?: number
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
    key: "claude-fable-5-1",
    id: "fable-5.1",
    input: 10,
    input_cached: 0.25,
    output: 50,
    search_cost: 0.01,
  },
  {
    provider: "anthropic",
    key: "claude-opus-5",
    id: "opus-5",
    input: 5,
    input_cached: 0.50,
    output: 25,
    search_cost: 0.01,
    default: true,
  },
  {
    provider: "anthropic",
    key: "claude-sonnet-5",
    id: "sonnet-5",
    // promotional pricing through 2026-08-31, then 3 / 0.30 / 15
    input: 2,
    input_cached: 0.20,
    output: 10,
    search_cost: 0.01,
  },
  {
    provider: "anthropic",
    key: "claude-haiku-4-5",
    id: "haiku-4.5",
    input: 1,
    input_cached: 0.1,
    output: 5,
    search_cost: 0.01,
  },
  {
    provider: "openai",
    key: "gpt-5.6-sol",
    id: "gpt-5.6-sol",
    input: 4.00,
    input_cached: 0.40,
    output: 20,
    search_cost: 0.01,
  },
  {
    provider: "openai",
    key: "gpt-5.6-terra",
    id: "gpt-5.6-terra",
    input: 2.00,
    input_cached: 0.20,
    output: 12,
    search_cost: 0.01,
  },
  {
    provider: "openai",
    key: "gpt-5.6-luna",
    id: "gpt-5.6-luna",
    input: 0.20,
    input_cached: 0.02,
    output: 1.20,
    search_cost: 0.01,
  },
  {
    provider: "google",
    key: "gemini-3.7-flash",
    id: "gemini-3.7-flash",
    input: 0.75,
    input_cached: 0.075,
    output: 3.75,
    // 1,500 RPD (free, limit shared with lite), then $35 / 1,000 grounded prompts
    search_cost: 0,
  },
  {
    provider: "google",
    key: "gemini-3.5-flash-lite",
    id: "gemini-3.5-flash-lite",
    input: .30,
    input_cached: 0.03,
    output: 2.50,
    // 1,500 RPD (free, limit shared with lite), then $35 / 1,000 grounded prompts
    search_cost: 0,
  },
]

/** Errors and exits if it can't resolve to a model */
export function resolveModel(
  modelArg: string | undefined,
  availableModels: readonly Model[] = models,
) {
  if (modelArg === undefined) return availableModels.find((m) => m.default)!

  // Find the first model containing the arg as a substring. See comment at
  // allModels definition about ordering.
  const lower = modelArg.toLowerCase()
  // First look for an exact match, then find the first model containing the arg
  // as a substring. See comment at allModels definition about ordering. Without
  // this logic, you could never match o1 if o1-mini is present.
  const match = availableModels.find((m) => m.key === lower || m.id === lower) ||
    availableModels.find((m) => m.key.includes(lower) || m.id.includes(lower))

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

export function getCost(model: Model, tokens: TokenCounts, searches = 0) {
  const { input, output, input_cached, search_cost } = model

  // when there is caching and we have cache pricing, take it into account
  const tokenCost = input_cached && tokens.input_cache_hit
    ? (input_cached * tokens.input_cache_hit) +
      (input * (tokens.input - tokens.input_cache_hit)) + (output * tokens.output)
    : (input * tokens.input) + (output * tokens.output)

  return tokenCost / M + (search_cost ?? 0) * searches
}

export const systemBase = $.dedent`
  - Answer the question precisely, without much elaboration
  - Write natural prose for a sophisticated reader, without unnecessary bullets or headings
  - Avoid referring to yourself in the first person. You are a computer program, not a person.
  - When asked to write code, primarily output code, with minimal explanation unless requested
  - When given code to modify, prefer diff output rather than rewriting the full input unless the input is short
  - Your answers MUST be in markdown format
  - Put code within a triple-backtick fence block with a language key (like \`\`\`rust)
  - Never put markdown prose (or bullets or whatever) in a fenced code block
  - When the answer is based on search, include citations directly in the response text when relevant

  Tailor answers to the user:
  - OS: macOS
  - Terminal: Ghostty
  - Text editor: Helix
  - Shell: zsh
  - Programming languages: TypeScript and Rust
  - Today's date is ${new Date().toISOString().slice(0, 10)}
`
