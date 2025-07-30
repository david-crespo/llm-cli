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

// deepseek is discounted from UTC 16:30-0:30
const utcMinutes = new Date().getUTCHours() * 60 + new Date().getUTCMinutes()
const deepseekDiscount = utcMinutes >= ((16 * 60) + 30) || utcMinutes <= 30

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
    key: "claude-sonnet-4-20250514",
    id: "sonnet-4",
    input: 3,
    input_cached: 0.30,
    output: 15,
  },
  {
    provider: "anthropic",
    key: "claude-opus-4-20250514",
    id: "opus-4",
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
    default: true,
  },
  {
    provider: "google",
    key: "gemini-2.5-flash",
    id: "gemini-2.5-flash",
    input: .30,
    input_cached: 0.075,
    output: 2.50,
  },
  {
    provider: "google",
    key: "gemini-2.5-flash-lite",
    id: "gemini-2.5-flash-lite",
    input: .10,
    input_cached: 0.025,
    output: .40,
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
    ...(deepseekDiscount
      ? {
        input: 0.135,
        input_cached: 0.035,
        output: 0.55,
      }
      : {
        input: 0.27,
        input_cached: 0.07,
        output: 1.10,
      }),
  },
  {
    provider: "deepseek",
    key: "deepseek-reasoner",
    id: "deepseek-r1",
    ...(deepseekDiscount
      ? {
        input: 0.135,
        input_cached: 0.035,
        output: 0.55,
      }
      : {
        input: 0.55,
        input_cached: 0.14,
        output: 2.19,
      }),
  },
  {
    provider: "groq",
    key: "moonshotai/kimi-k2-instruct",
    id: "groq-kimi-k2",
    input: 1.00,
    output: 3.00,
  },
  // technically free until they set up their paid tier but whatever
  {
    provider: "cerebras",
    key: "qwen-3-235b-a22b-instruct-2507",
    id: "qwen-3-235b",
    input: 0.60,
    output: 1.20,
  },
  {
    provider: "cerebras",
    key: "qwen-3-32b",
    id: "qwen-3-32b",
    input: 0.40,
    output: 0.80,
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
`
