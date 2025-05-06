import { ValidationError } from "jsr:@cliffy/command@1.0.0-rc.7"
import { type TokenCounts } from "./types.ts"
import $ from "jsr:@david/dax@0.42"

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
    id: "3.7-sonnet",
    input: 3,
    input_cached: 0.3,
    output: 15,
    // default: true,
  },
  {
    provider: "anthropic",
    key: "claude-3-5-haiku-latest",
    id: "3.5-haiku",
    input: 0.8,
    input_cached: 0.08,
    output: 4,
  },
  {
    provider: "google",
    key: "gemini-2.5-pro-preview-05-06",
    id: "gemini-2.5-pro",
    input: 1.25,
    output: 10.00,
    default: true,
  },
  {
    provider: "google",
    key: "gemini-2.5-flash-preview-04-17",
    id: "gemini-2.5-flash",
    input: .15,
    output: .60,
  },
  {
    provider: "google",
    key: "gemini-2.5-flash-preview-04-17",
    id: "gemini-2.5-flash-thinking",
    input: .15,
    output: 3.50,
  },
  {
    provider: "openai",
    key: "gpt-4.1",
    id: "gpt-4.1",
    input: 2.00,
    input_cached: 0.50,
    output: 8.00,
  },
  {
    provider: "openai",
    key: "gpt-4.1-mini",
    id: "gpt-4.1-mini",
    input: .40,
    input_cached: 0.10,
    output: 1.60,
  },
  {
    provider: "openai",
    key: "gpt-4.5-preview",
    id: "gpt-4.5",
    input: 75,
    input_cached: 37.50,
    output: 150,
  },
  // {
  //   provider: "openai",
  //   key: "o3",
  //   id: "o3",
  //   input: 10,
  //   input_cached: 2.50,
  //   output: 40,
  // },
  {
    provider: "openai",
    key: "o4-mini",
    id: "o4-mini",
    input: 1.10,
    input_cached: 0.275,
    output: 4.40,
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
    key: "meta-llama/llama-4-scout-17b-16e-instruct",
    id: "llama-4-scout",
    input: 0.11,
    output: 0.34,
  },
  {
    provider: "groq",
    key: "meta-llama/llama-4-maverick-17b-128e-instruct",
    id: "llama-4-maverick",
    input: 0.50,
    output: 0.77,
  },
  {
    provider: "groq",
    key: "llama-3.3-70b-versatile",
    id: "groq-llama",
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
  {
    provider: "cerebras",
    key: "llama-4-scout",
    id: "cerebras-scout",
    input: 0.65,
    output: 0.85,
  },
]

/** Errors and exits if it can't resolve to a model */
export function resolveModel(modelArg: string | undefined) {
  if (modelArg === undefined) return models.find((m) => m.default)!

  // Find the first model containing the arg as a substring. See comment at
  // allModels definition about ordering.
  const lower = modelArg.toLowerCase()
  // First look for an exact match, then find the first model containing the arg
  // as a substring. See comment at allModels definition about ordering. Without
  // this logic, you could never match o1 if o1-mini is present.
  const match = models.find((m) => m.key === lower || m.id === lower) ||
    models.find((m) => m.key.includes(lower) || m.id.includes(lower))

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

  return cost / M
}

export const systemBase = $.dedent`
  - Answer the question precisely, without much elaboration
  - Write natural prose for a sophisticated reader, without unnecessary bullets or headings
  - When asked to write code, primarily output code, with minimal explanation unless requested
  - Your answers MUST be in markdown format
  - Put code within a triple-backtick fence block with a language key (like \`\`\`rust)
  - Never put markdown prose (or bullets or whatever) in a fenced code block

  Tailor answers to the user:
  - OS: macOS
  - Terminal: Ghostty
  - Text editor: Helix
  - Shell: zsh
  - Programming languages: TypeScript and Rust
`
