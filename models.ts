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
  /**
   * Price for tokens written to the prompt cache. For Anthropic this depends on
   * cache TTL (1.25x input for 5m, 2x for 1h). We don't set a TTL, so 5m applies.
   */
  input_cache_write?: number
  /** Cost per web search in dollars */
  search_cost?: number
  /** Image generation model. `output` is the price per image output token. */
  kind?: "image"
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
    input_cache_write: 12.5,
    output: 50,
    search_cost: 0.01,
  },
  {
    provider: "anthropic",
    key: "claude-opus-5-5",
    id: "opus-5.5",
    input: 4,
    input_cached: 0.20,
    input_cache_write: 5,
    output: 20,
    search_cost: 0.01,
    default: true,
  },
  {
    provider: "anthropic",
    key: "claude-sonnet-5-5",
    id: "sonnet-5.5",
    input: 2,
    input_cached: 0.20,
    input_cache_write: 2.50,
    output: 10,
    search_cost: 0.01,
  },
  {
    provider: "openai",
    key: "gpt-6-astra",
    id: "gpt-6-astra",
    input: 10.00,
    input_cached: 1.00,
    output: 50,
    search_cost: 0.01,
  },
  {
    provider: "openai",
    key: "gpt-6-sol",
    id: "gpt-6-sol",
    input: 2,
    input_cached: 0.20,
    output: 10,
    search_cost: 0.01,
  },
  {
    provider: "openai",
    key: "gpt-6-luna",
    id: "gpt-6-luna",
    input: 0.10,
    input_cached: 0.01,
    output: 0.50,
    search_cost: 0.01,
  },
  {
    provider: "openai",
    key: "gpt-image-2.5-flare",
    id: "gpt-image-2.5-flare",
    kind: "image",
    input: 5,
    input_cached: 1.25,
    output: 30,
  },
  {
    provider: "openai",
    key: "gpt-image-2.5-sunburst",
    id: "gpt-image-2.5-sunburst",
    kind: "image",
    input: 5,
    input_cached: 1.25,
    output: 30,
  },
  {
    provider: "google",
    key: "gemini-3.8-flash",
    id: "gemini-3.8-flash",
    input: 0.75,
    input_cached: 0.075,
    output: 3.75,
    // 5,000 search queries/month free (shared across 3.x models), then $14 / 1,000.
    // We never get anywhere near the limit, so treat as free.
    search_cost: 0,
  },
  {
    provider: "google",
    key: "gemini-3.5-flash-lite",
    id: "gemini-3.5-flash-lite",
    input: .30,
    input_cached: 0.03,
    output: 2.50,
    // 5,000 search queries/month free (shared across 3.x models), then $14 / 1,000.
    // We never get anywhere near the limit, so treat as free.
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
  const { input, output, input_cached, input_cache_write, search_cost } = model

  // Cache hits and writes are subsets of tokens.input. Price them separately
  // when the model has the corresponding price, otherwise at the input rate.
  const hits = input_cached ? tokens.input_cache_hit ?? 0 : 0
  const writes = input_cache_write ? tokens.input_cache_write ?? 0 : 0
  const tokenCost = (input_cached ?? 0) * hits +
    (input_cache_write ?? 0) * writes +
    input * (tokens.input - hits - writes) +
    output * tokens.output

  return tokenCost / M + (search_cost ?? 0) * searches
}

export const systemBase = $.dedent`
  - Answer the question precisely, without much elaboration
  - Write natural prose for a sophisticated reader, without unnecessary bullets or headings
  - When asked to write code, primarily output code, with minimal explanation unless requested
  - When given code to modify, prefer diff output rather than rewriting the full input unless the input is short
  - Your answers MUST be in markdown format
  - Put code within a triple-backtick fence block with a language key (like \`\`\`rust)
  - Never put markdown prose (or bullets or whatever) in a fenced code block
  - Use \\(...\\) for inline math and $$...$$ or \\[...\\] for display math. Put display delimiters on their own lines. Write literal math delimiters in code spans.
  - Use math delimiters only for notation that plain text can't express clearly: variables and functions, Greek letters, stacked fractions, roots, sums and integrals, matrices, and multi-term expressions or equations involving variables. Everything else stays as text, using Unicode symbols where needed: "657 TWh", "0.35-0.60 tonnes", "$300-$500", "~$300", "2/3", "2³² − 1", "3×10⁸ m/s", "m/s²", "CO₂", "p < 0.05", "10 ± 2", "a 3×3 matrix". In programming contexts, put expressions in code spans, not math. Inside an actual equation, use \\$ for a dollar sign.
  - Keep inline math short. Use display math for tall fractions, matrices, sums with limits, and multi-line derivations (with an aligned environment).
  - When the answer is based on search, include citations directly in the response text when relevant

  Tailor answers to the user:
  - OS: macOS
  - Terminal: Ghostty
  - Text editor: Helix
  - Shell: zsh
  - Programming languages: TypeScript and Rust
  - Today's date is ${new Date().toISOString().slice(0, 10)}
`
