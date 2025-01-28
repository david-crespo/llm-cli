export type Price = { input: number; output: number; input_cached?: number }

export const M = 1_000_000

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
  "claude-3-5-sonnet-latest": { input: 3 / M, output: 15 / M },
  "claude-3-5-haiku-latest": { input: 1 / M, output: 5 / M },
  "chatgpt-4o-latest": { input: 2.5 / M, input_cached: 1.25 / M, output: 10 / M },
  "gpt-4o-mini": { input: .15 / M, input_cached: 0.075 / M, output: .6 / M },
  "o1-mini": { input: 3 / M, input_cached: 1.5 / M, output: 12 / M },
  "o1-preview": { input: 15 / M, input_cached: 7.5 / M, output: 60 / M },
  "gemini-exp-1206": { input: 1.25 / M, output: 2.50 / M }, // >128k: 5 / 10
  "gemini-2.0-flash-exp": { input: .075 / M, output: .3 / M }, // >128k: 0.15 / 0.60
  "gemini-2.0-flash-thinking-exp": { input: .35 / M, output: 1.5 / M }, // estimated
  "groq-llama-3.3-70b-versatile": { input: .59 / M, output: 0.79 / M },
  // no price online so assume same as llama-70b for now
  "groq-deepseek-r1-distill-llama-70b": { input: .59 / M, output: 0.79 / M },
  "deepseek-chat": { input: 0.14 / M, input_cached: 0.014 / M, output: 0.28 / M },
  "deepseek-reasoner": { input: 0.55 / M, input_cached: 0.14 / M, output: 2.19 / M },
  // technically free until they set up their paid tier but whatever
  "cerebras-llama-3.3-70b": { input: 0.85 / M, output: 1.20 / M },
})

export type Model = keyof typeof models
export const defaultModel: Model = "claude-3-5-sonnet-latest"
