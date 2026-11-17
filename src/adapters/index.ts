import type { Model } from "../models.ts"
import type { ThinkLevel } from "../types.ts"
import type { ChatInput, ModelResponse } from "./types.ts"

export type { ChatInput, ImageOptions, ModelResponse, ToolConfig } from "./types.ts"
export { imageQualities } from "./types.ts"
export type { ThinkLevel } from "../types.ts"

export const searchProviders = new Set(["anthropic", "openai", "google"])
export const thinkProviders = new Set(["anthropic", "openai", "google"])
export const imageInputProviders = new Set(["anthropic", "openai", "google"])

// The provider SDKs are a few hundred modules together, so load each adapter
// on first use rather than on every startup
const openai = () => import("./openai.ts")

export async function createMessage(input: ChatInput): Promise<ModelResponse> {
  const { provider } = input.model
  if (input.model.kind === "image") {
    return provider === "google"
      ? (await import("./gemini.ts")).geminiImageCreateMessage(input)
      : (await openai()).gptImageCreateMessage(input)
  }
  if (provider === "anthropic") {
    return (await import("./claude.ts")).claudeCreateMessage(input)
  }
  if (provider === "google") return (await import("./gemini.ts")).geminiCreateMessage(input)
  if (provider === "openrouter") return (await openai()).openrouterCreateMessage(input)
  return (await openai()).gptCreateMessage(input)
}

/**
 * The effort `model` uses by default and for each thinking flag, or undefined
 * if it takes no thinking level. Loads only that provider's adapter.
 */
export async function thinkEfforts(model: Model) {
  const effortFor = await (async (): Promise<
    ((level: ThinkLevel | undefined) => string) | undefined
  > => {
    if (model.provider === "anthropic") {
      const { claudeThinkParams } = await import("./claude.ts")
      return (level) => claudeThinkParams(level).effort
    }
    if (model.provider === "google") {
      const { geminiThinkParams } = await import("./gemini.ts")
      return (level) => geminiThinkParams(model.key, level).effort
    }
    // OpenAI image models take no thinking level
    if (model.provider === "openai" && model.kind !== "image") {
      return (await openai()).openAIEffort
    }
  })()
  if (!effortFor) return undefined
  return {
    default: effortFor(undefined),
    on: effortFor("on"),
    high: effortFor("high"),
    off: effortFor("off"),
  }
}

type GptBg = typeof import("./openai.ts").gptBg

export const gptBg: GptBg = {
  initiate: async (...args) => (await openai()).gptBg.initiate(...args),
  retrieve: async (...args) => (await openai()).gptBg.retrieve(...args),
  status: async (...args) => (await openai()).gptBg.status(...args),
  cancel: async (...args) => (await openai()).gptBg.cancel(...args),
}
