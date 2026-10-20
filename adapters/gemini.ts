import { GoogleGenAI, type Part, ThinkingLevel } from "@google/genai"
import { Buffer } from "node:buffer"

import { postprocessSchemaContent, prepareSchema } from "../schema.ts"
import { getCost } from "../models.ts"
import { parseDataUrl } from "../utils.ts"
import type { ThinkLevel } from "../types.ts"
import type { ChatInput } from "./types.ts"
import { validateRequestSize } from "./request_size.ts"

/** Gemini doesn't accept image URLs directly; inline as bytes either way. */
async function imageToInlinePart(image_url: string): Promise<Part> {
  const parsed = parseDataUrl(image_url)
  if (parsed) {
    return { inlineData: { mimeType: parsed.mediaType, data: parsed.data } }
  }
  const res = await fetch(image_url)
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`)
  const buf = new Uint8Array(await res.arrayBuffer())
  const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/png"
  return { inlineData: { mimeType, data: Buffer.from(buf).toString("base64") } }
}

export function geminiThinkParams(key: string, think: ThinkLevel | undefined) {
  // full flash models reject MINIMAL: "Thinking level MINIMAL is not supported"
  const isFlashLite = key.includes("flash-lite")
  // Always send an explicit level rather than relying on per-model server
  // defaults. Default to "on" like the other providers; flash-lite defaults
  // to "off" (MINIMAL, also Google's default), like Haiku on Claude.
  const level = think ?? (isFlashLite ? "off" : "on")
  if (level === "high") {
    return { thinkingLevel: ThinkingLevel.HIGH, effort: "high" }
  }
  if (level === "on") {
    return { thinkingLevel: ThinkingLevel.MEDIUM, effort: "medium" }
  }
  return isFlashLite
    ? { thinkingLevel: ThinkingLevel.MINIMAL, effort: "minimal" }
    : { thinkingLevel: ThinkingLevel.LOW, effort: "low" }
}

export async function geminiCreateMessage(
  { chat, model, config, signal, outputSchema }: ChatInput,
) {
  const apiKey = Deno.env.get("GEMINI_API_KEY")
  if (!apiKey) throw Error("GEMINI_API_KEY missing")

  const { thinkingLevel, effort } = geminiThinkParams(model.key, config.think)

  // Gemini accepts primitive roots; no wrap needed.
  const prep = outputSchema ? prepareSchema(outputSchema) : undefined

  const generationConfig = {
    // https://ai.google.dev/gemini-api/docs/thinking
    thinkingConfig: {
      includeThoughts: true,
      thinkingLevel,
    },
    responseMimeType: prep ? "application/json" : undefined,
    responseJsonSchema: prep?.schema,
  }
  const systemInstruction = { role: "user", parts: [{ text: chat.systemPrompt }] }
  const tools = [
    // always include URL context. it was designed to be used this way
    { urlContext: {} },
    ...(config.search ? [{ googleSearch: {} }] : []),
  ]
  const contents = await Promise.all(chat.messages.map(async (msg) => {
    const parts: Part[] = msg.content ? [{ text: msg.content }] : []
    if (msg.role === "user" && msg.image_urls?.length) {
      parts.unshift(...await Promise.all(msg.image_urls.map(imageToInlinePart)))
    }
    return {
      // gemini uses model instead of assistant
      role: msg.role === "assistant" ? "model" : "user",
      parts,
    }
  }))
  // The SDK moves systemInstruction/tools out of config and places its remaining
  // fields in generationConfig. Measure that REST body after inlining URL images.
  validateRequestSize("Gemini", { contents, systemInstruction, tools, generationConfig })
  const result = await new GoogleGenAI({ apiKey }).models.generateContent({
    model: model.key,
    contents,
    config: { ...generationConfig, systemInstruction, tools, abortSignal: signal },
  })

  // console.log(JSON.stringify(result, null, 2))

  const parts = result.candidates?.[0].content?.parts ?? []
  const reasoning = parts.filter((p) => p.text && p.thought).map((p) => p.text!).join(
    "\n\n",
  )
  let content = parts.filter((p) => p.text && !p.thought).map((p) => p.text!).join("\n\n")

  const searchResults = result.candidates?.[0].groundingMetadata?.groundingChunks
  const searches = searchResults && searchResults.length > 0 ? 1 : 0
  const searchResultsMd = searchResults
    ? "\n\n### Sources\n\n" + searchResults
      .filter((chunk) => chunk.web)
      .map((chunk) => `- [${chunk.web!.title}](${chunk.web!.uri})`).join("\n")
    : ""

  if (!prep) content += searchResultsMd

  if (prep) content = postprocessSchemaContent(content, prep.wrapped)

  const tokens = {
    input: result.usageMetadata?.promptTokenCount || 0,
    output: (result.usageMetadata?.candidatesTokenCount || 0) +
      (result.usageMetadata?.thoughtsTokenCount || 0),
    input_cache_hit: result.usageMetadata?.cachedContentTokenCount || 0,
  }

  return {
    content,
    reasoning,
    tokens,
    cost: getCost(model, tokens, searches),
    stop_reason: result.candidates?.[0].finishReason || "",
    searches: searches || undefined,
    effort,
  }
}
