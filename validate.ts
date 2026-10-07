import type { Model } from "./models.ts"
import {
  imageInputProviders,
  searchProviders,
  thinkProviders,
  type ToolConfig,
} from "./adapters/mod.ts"

/** Request flags that some models can't take, resolved from the CLI options */
export type RequestFlags = {
  reply: boolean
  system: boolean
  images: boolean
  config: ToolConfig
  outputSchema: boolean
  background: boolean
  quality?: string
  size?: string
}

/** No need to pass --background for gpt-5.4-pro: it always needs it */
export const usesBackground = (model: Model, background: boolean) =>
  background || model.id === "gpt-5.4-pro"

/** Everything about the request `model` can't do, empty if it's fine */
export function requestProblems(model: Model, req: RequestFlags): string[] {
  const { provider } = model
  const problems: string[] = []

  if (req.config.search && !searchProviders.has(provider)) {
    problems.push(`Search not supported for ${provider}`)
  }
  if (req.config.think !== undefined && !thinkProviders.has(provider)) {
    problems.push(`Thinking control not supported for ${provider}`)
  }

  if (model.kind === "image") {
    // Image models only take a fresh text prompt for now
    const unsupported = [
      req.reply && "-r (use -m to pick a text model)",
      req.system && "--system",
      req.images && "--image",
      req.config.search && "--search",
      req.config.think !== undefined && "thinking flags",
      req.outputSchema && "--output-schema",
      req.background && "--background",
    ].filter(Boolean)
    if (unsupported.length > 0) {
      problems.push(`Not supported for image models: ${unsupported.join(", ")}`)
    }
    if (req.size && !/^(auto|\d+x\d+)$/.test(req.size)) {
      problems.push(`Invalid size '${req.size}'. Use WIDTHxHEIGHT or auto`)
    }
  } else if (req.quality || req.size) {
    problems.push("--quality and --size only apply to image models")
  }

  if (req.images && !imageInputProviders.has(provider)) {
    problems.push(`Images not supported for ${provider}`)
  }
  if (req.background && provider !== "openai") {
    problems.push("Background mode only works with OpenAI models")
  }
  if (req.outputSchema && usesBackground(model, req.background)) {
    problems.push("Structured output is not supported in background mode")
  }

  return problems
}
