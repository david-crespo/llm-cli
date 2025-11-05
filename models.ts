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
    key: "claude-sonnet-4-5",
    id: "sonnet-4.5",
    input: 3,
    input_cached: 0.30,
    output: 15,
    default: true,
  },
  {
    provider: "anthropic",
    key: "claude-haiku-4-5",
    id: "haiku-4.5",
    input: 1,
    input_cached: 0.1,
    output: 5,
  },
  {
    provider: "anthropic",
    key: "claude-opus-4-1-20250805",
    id: "opus-4.1",
    input: 15,
    input_cached: 1.50,
    output: 75,
  },
  {
    provider: "google",
    key: "gemini-2.5-pro",
    id: "gemini-2.5-pro",
    input: 1.25,
    input_cached: 0.31,
    output: 10.00,
  },
  {
    provider: "google",
    key: "gemini-flash-latest",
    id: "gemini-2.5-flash",
    input: .30,
    input_cached: 0.075,
    output: 2.50,
  },
  {
    provider: "google",
    key: "gemini-flash-lite-latest",
    id: "gemini-2.5-flash-lite",
    input: .10,
    input_cached: 0.025,
    output: .40,
  },
  {
    provider: "openai",
    key: "gpt-5",
    id: "gpt-5",
    input: 1.25,
    input_cached: 0.125,
    output: 10,
  },
  {
    provider: "openai",
    key: "gpt-5-pro",
    id: "gpt-5-pro",
    input: 15, // no caching, yikes
    output: 120,
  },
  {
    provider: "openai",
    key: "gpt-5-mini",
    id: "gpt-5-mini",
    input: .25,
    input_cached: 0.025,
    output: 2.00,
  },
  {
    provider: "openai",
    key: "gpt-5-nano",
    id: "gpt-5-nano",
    input: 0.05,
    input_cached: 0.005,
    output: 0.40,
  },
  {
    provider: "deepseek",
    key: "deepseek-chat",
    id: "deepseek-v3.1",
    input: 0.56,
    input_cached: 0.07,
    output: 1.68,
  },
  {
    provider: "deepseek",
    key: "deepseek-reasoner",
    id: "deepseek-v3.1-thinking",
    input: 0.56,
    input_cached: 0.07,
    output: 1.68,
  },
  {
    provider: "groq",
    key: "moonshotai/kimi-k2-instruct-0905",
    id: "kimi-k2",
    input: 1.00,
    input_cached: 0.50,
    output: 3.00,
  },
  {
    provider: "cerebras",
    key: "zai-glm-4.6",
    id: "glm-4.6",
    input: 2.25,
    output: 2.75,
  },
  {
    provider: "cerebras",
    key: "gpt-oss-120b",
    id: "gpt-oss-120b",
    input: 0.35,
    output: 0.75,
  },
  {
    provider: "openrouter",
    key: "qwen/qwen3-max",
    id: "qwen-3-max",
    // note these are $3, $0.60, and $15 over 128k but whatev
    input: 1.20,
    input_cached: 0.24,
    output: 6.00,
  },
  {
    provider: "openrouter",
    key: "openrouter/polaris-alpha",
    id: "polaris-alpha",
    input: 0,
    output: 0,
  },
  {
    provider: "xai",
    key: "grok-4",
    id: "grok-4",
    input: 3.00,
    input_cached: 0.75,
    output: 15.00,
  },
  {
    provider: "xai",
    key: "grok-4-fast-reasoning",
    id: "grok-4-fast",
    input: 0.20,
    input_cached: 0.05,
    output: 0.50,
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
  - Avoid referring to yourself in the first person. You are a computer program, not a person.
  - When asked to write code, primarily output code, with minimal explanation unless requested
  - When given code to modify, prefer diff output rather than rewriting the full input unless the input is short
  - Your answers MUST be in markdown format
  - Put code within a triple-backtick fence block with a language key (like \`\`\`rust)
  - Never put markdown prose (or bullets or whatever) in a fenced code block

  Tailor answers to the user:
  - OS: macOS
  - Terminal: Ghostty
  - Text editor: Helix
  - Shell: zsh
  - Programming languages: TypeScript and Rust
  - Today's date is ${new Date().toISOString().slice(0, 10)}
`
