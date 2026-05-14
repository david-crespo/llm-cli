import { GoogleGenAI, type Part, ThinkingLevel } from "@google/genai"
import { encodeBase64 } from "@std/encoding/base64"
import { match, P } from "ts-pattern"

import { postprocessSchemaContent, prepareSchema } from "../schema.ts"
import { getCost } from "../models.ts"
import { parseDataUrl } from "../utils.ts"
import type { ChatInput } from "./types.ts"

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
  return { inlineData: { mimeType, data: encodeBase64(buf) } }
}

export async function geminiCreateMessage(
  { chat, model, config, signal, outputSchema }: ChatInput,
) {
  const apiKey = Deno.env.get("GEMINI_API_KEY")
  if (!apiKey) throw Error("GEMINI_API_KEY missing")

  const isFlash = model.key.includes("flash")

  // Gemini accepts primitive roots; no wrap needed.
  const prep = outputSchema ? prepareSchema(outputSchema) : undefined

  const result = await new GoogleGenAI({ apiKey }).models.generateContent({
    config: {
      // https://ai.google.dev/gemini-api/docs/thinking
      thinkingConfig: {
        includeThoughts: true,
        thinkingLevel: match(config.think)
          .with("high", () => ThinkingLevel.HIGH)
          .with("on", () => ThinkingLevel.MEDIUM)
          // Flash supports "minimal", Pro only goes down to "low"
          .with("off", () => isFlash ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW)
          .with(P.nullish, () => undefined) // default to dynamic
          .exhaustive(),
      },
      systemInstruction: chat.systemPrompt,
      tools: [
        // always include URL context. it was designed to be used this way
        { urlContext: {} },
        ...(config.search ? [{ googleSearch: {} }] : []),
      ],
      responseMimeType: prep ? "application/json" : undefined,
      responseJsonSchema: prep?.schema,
      abortSignal: signal,
    },
    model: model.key,
    contents: await Promise.all(chat.messages.map(async (msg) => {
      const parts: Part[] = [{ text: msg.content }]
      if (msg.role === "user" && msg.image_url) {
        parts.unshift(await imageToInlinePart(msg.image_url))
      }
      return {
        // gemini uses model instead of assistant
        role: msg.role === "assistant" ? "model" : "user",
        parts,
      }
    })),
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

  // HACK for higher pricing over 200k https://ai.google.dev/pricing
  const costModel = model.id === "gemini-3-pro" && tokens.input > 200_000
    ? { ...model, input: 4.00, output: 18.00 }
    : model

  return {
    content,
    reasoning,
    tokens,
    cost: getCost(costModel, tokens, searches),
    stop_reason: result.candidates?.[0].finishReason || "",
    searches: searches || undefined,
  }
}
