import type { ChatInput, ModelResponse } from "./types.ts"

export type { ChatInput, ImageOptions, ModelResponse, ToolConfig } from "./types.ts"
export { imageQualities } from "./types.ts"
export type { ThinkLevel } from "../types.ts"

export const searchProviders = new Set(["anthropic", "openai", "google"])
export const thinkProviders = new Set(["anthropic", "openai", "google", "baseten"])
export const imageInputProviders = new Set(["anthropic", "openai", "google"])

// The provider SDKs are a few hundred modules together, so load each adapter
// on first use rather than on every startup
const openai = () => import("./openai.ts")

export async function createMessage(input: ChatInput): Promise<ModelResponse> {
  const { provider } = input.model
  if (input.model.kind === "image") return (await openai()).gptImageCreateMessage(input)
  if (provider === "anthropic") {
    return (await import("./claude.ts")).claudeCreateMessage(input)
  }
  if (provider === "google") return (await import("./gemini.ts")).geminiCreateMessage(input)
  if (provider === "openrouter") return (await openai()).openrouterCreateMessage(input)
  return (await openai()).gptCreateMessage(input)
}

type GptBg = typeof import("./openai.ts").gptBg

export const gptBg: GptBg = {
  initiate: async (...args) => (await openai()).gptBg.initiate(...args),
  retrieve: async (...args) => (await openai()).gptBg.retrieve(...args),
  status: async (...args) => (await openai()).gptBg.status(...args),
  cancel: async (...args) => (await openai()).gptBg.cancel(...args),
}
