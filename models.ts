// prices are per million tokens
type Price = { input: number; output: number; input_cached?: number }

// keep the Price type for inferred values while keeping const keys
const makeModels = <T extends Record<string, Price>>(models: T): Record<keyof T, Price> =>
  models

/**
 * The order matters: preferred models go first.
 *
 * We pick a model by finding the first one containing the specified string.
 * But the same string can be in multiple model names. For example, "mini" is
 * in both gpt-4o-mini and the gemini models. By putting gpt-4o-mini earlier, we
 * ensure "mini" matches that. By putting gpt-4o first, we ensure "4o" matches
 * that.
 */
export const models = makeModels({
  "claude-3-5-sonnet-latest": { input: 3, output: 15 },
  "claude-3-5-haiku-latest": { input: 1, output: 5 },
  "chatgpt-4o-latest": { input: 2.5, input_cached: 1.25, output: 10 },
  "gpt-4o-mini": { input: .15, input_cached: 0.075, output: .6 },
  "o1-mini": { input: 3, input_cached: 1.5, output: 12 },
  "o1-preview": { input: 15, input_cached: 7.5, output: 60 },
  "gemini-exp-1206": { input: 1.25, output: 2.50 }, // >128k: 5 / 10
  "gemini-2.0-flash-exp": { input: .075, output: .3 }, // >128k: 0.15 / 0.60
  "gemini-2.0-flash-thinking-exp": { input: .35, output: 1.5 }, // estimated
  "groq-llama-3.3-70b-versatile": { input: .59, output: 0.79 },
  // no price online so assume same as llama-70b for now
  "groq-deepseek-r1-distill-llama-70b": { input: .59, output: 0.79 },
  "deepseek-chat": { input: 0.14, input_cached: 0.014, output: 0.28 },
  "deepseek-reasoner": { input: 0.55, input_cached: 0.14, output: 2.19 },
  // technically free until they set up their paid tier but whatever
  "cerebras-llama-3.3-70b": { input: 0.85, output: 1.20 },
})

export type Model = keyof typeof models
export const defaultModel: Model = "claude-3-5-sonnet-latest"
