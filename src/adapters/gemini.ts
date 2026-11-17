import {
  type GenerateContentResponse,
  GoogleGenAI,
  type GroundingMetadata,
  MediaModality,
  type Part,
  ThinkingLevel,
} from "@google/genai"
import $ from "dax"
import { Buffer } from "node:buffer"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { postprocessSchemaContent, prepareSchema } from "../schema.ts"
import { getCost, type Model } from "../models.ts"
import { parseDataUrl } from "../image-input.ts"
import type { ThinkLevel } from "../types.ts"
import { type ChatInput, imagePrompt, type ModelResponse } from "./types.ts"
import { saveImage } from "../storage.ts"
import { validateRequestSize } from "./request-size.ts"

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
  // Gemini 4 and full flash models reject MINIMAL: "Thinking level MINIMAL is not supported"
  const isFlashLite = key.includes("flash-lite")
  // Nano Banana takes MINIMAL, MEDIUM, and HIGH, and can't turn thinking off
  const offIsMinimal = isFlashLite || key.includes("nano-banana")
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
  return offIsMinimal
    ? { thinkingLevel: ThinkingLevel.MINIMAL, effort: "minimal" }
    : { thinkingLevel: ThinkingLevel.LOW, effort: "low" }
}

/**
 * Joins the answer's text parts and cites their web sources. Each grounding
 * support ties a span of the answer to the chunks behind it, and the span gets
 * a [n] marker. Sources numbers cited chunks in order of first citation, then
 * lists the uncited ones the search also found.
 */
export function withCitations(parts: Part[], grounding: GroundingMetadata | undefined) {
  const chunks = grounding?.groundingChunks ?? []
  // Chunks can repeat a URL, so number sources by URL
  const numbers = new Map<string, number>()
  const sources: string[] = []
  const cite = (chunkIndex: number) => {
    const web = chunks[chunkIndex]?.web
    if (!web?.uri) return []
    if (!numbers.has(web.uri)) {
      numbers.set(web.uri, numbers.size + 1)
      sources.push(`${numbers.size}. [${web.title || web.uri}](${web.uri})`)
    }
    return [numbers.get(web.uri)!]
  }

  // Segment offsets are UTF-8 bytes into the answer's text parts joined, like
  // the SDK's response.text. Responses leave out partIndex even when thought
  // parts come first, so ignore it.
  const bytes = Buffer.from(
    parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text!)
      .join(""),
  )
  const byEnd = new Map<number, number[]>()
  for (const s of grounding?.groundingSupports ?? []) {
    if (!s.segment?.endIndex) continue
    const end = Math.min(s.segment.endIndex, bytes.length)
    const indices = byEnd.get(end) ?? []
    indices.push(...(s.groundingChunkIndices ?? []))
    byEnd.set(end, indices)
  }
  let content = ""
  let start = 0
  for (const [end, chunkIndices] of [...byEnd].sort(([a], [b]) => a - b)) {
    const cited = [...new Set(chunkIndices.flatMap(cite))].sort((a, b) => a - b)
    if (cited.length === 0) continue
    content += bytes.subarray(start, end).toString() + `[${cited.join(", ")}]`
    start = end
  }
  content += bytes.subarray(start).toString()

  chunks.forEach((_, i) => cite(i))
  return sources.length > 0 ? `${content}\n\n### Sources\n\n${sources.join("\n")}` : content
}

export async function geminiCreateMessage({
  chat,
  model,
  apiKey,
  config,
  signal,
  outputSchema,
}: ChatInput) {
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
  const contents = await Promise.all(
    chat.messages.map(async (msg) => {
      const parts: Part[] = msg.content ? [{ text: msg.content }] : []
      if (msg.role === "user" && msg.image_urls?.length) {
        parts.unshift(...(await Promise.all(msg.image_urls.map(imageToInlinePart))))
      }
      return {
        // gemini uses model instead of assistant
        role: msg.role === "assistant" ? "model" : "user",
        parts,
      }
    }),
  )
  // The SDK moves systemInstruction/tools out of config and places its remaining
  // fields in generationConfig. Measure that REST body after inlining URL images.
  validateRequestSize("Gemini", { contents, systemInstruction, tools, generationConfig })
  const result = await new GoogleGenAI({ apiKey }).models.generateContent({
    model: model.key,
    contents,
    config: { ...generationConfig, systemInstruction, tools, abortSignal: signal },
  })

  const parts = result.candidates?.[0].content?.parts ?? []
  const reasoning = parts
    .filter((p) => p.text && p.thought)
    .map((p) => p.text!)
    .join("\n\n")
  const grounding = result.candidates?.[0].groundingMetadata
  const searches = grounding?.groundingChunks?.length ? 1 : 0
  const content = prep
    ? postprocessSchemaContent(
        parts
          .filter((p) => p.text && !p.thought)
          .map((p) => p.text!)
          .join("\n\n"),
        prep.wrapped,
      )
    : withCitations(parts, grounding)

  const tokens = {
    input: result.usageMetadata?.promptTokenCount || 0,
    output:
      (result.usageMetadata?.candidatesTokenCount || 0) +
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

/** Nano Banana returns JPEG, but Kitty graphics only display PNG */
async function toPng(bytes: Uint8Array, mimeType: string): Promise<Uint8Array> {
  if (mimeType === "image/png") return bytes
  const dir = await mkdtemp(join(tmpdir(), "llm-cli-"))
  try {
    const [input, output] = [join(dir, "input"), join(dir, "output.png")]
    await writeFile(input, bytes)
    await $`sips -s format png ${input} --out ${output}`.quiet()
    return await readFile(output)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function geminiImageCreateMessage({
  chat,
  model,
  apiKey,
  config,
  signal,
  imageOptions,
}: ChatInput): Promise<ModelResponse> {
  const prompt = imagePrompt(chat)
  const { thinkingLevel, effort } = geminiThinkParams(model.key, config.think)
  const result = await new GoogleGenAI({ apiKey }).models.generateContent({
    model: model.key,
    contents: prompt,
    config: {
      thinkingConfig: { thinkingLevel },
      // Google's default is 1K
      imageConfig: {
        imageSize: imageOptions?.size ?? "2K",
        aspectRatio: imageOptions?.aspect,
      },
      abortSignal: signal,
    },
  })
  const response = await processGeminiImageResponse(
    result,
    model,
    async (bytes, mimeType, i) => saveImage(await toPng(bytes, mimeType), prompt, "png", i),
  )
  return { ...response, effort }
}

export async function processGeminiImageResponse(
  result: GenerateContentResponse,
  model: Model,
  save: (bytes: Uint8Array, mimeType: string, index: number) => Promise<string>,
): Promise<ModelResponse> {
  const parts = result.candidates?.[0].content?.parts ?? []
  // Thought parts can include draft images; keep only the final ones
  const answer = parts.filter((p) => !p.thought)
  const images = await Promise.all(
    answer
      .filter((p) => p.inlineData?.data)
      .map(({ inlineData }, i) =>
        save(Buffer.from(inlineData!.data!, "base64"), inlineData!.mimeType ?? "", i),
      ),
  )
  // A refusal or safety block comes back as text with no image
  const text = answer.flatMap((p) => (p.text ? [p.text] : [])).join("\n\n")
  if (images.length === 0) {
    const reason = result.candidates?.[0].finishReason ?? result.promptFeedback?.blockReason
    throw new Error(`No image in response (${reason})${text ? `: ${text}` : ""}`)
  }

  const usage = result.usageMetadata
  const tokens = {
    input: usage?.promptTokenCount ?? 0,
    output: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    output_image: (usage?.candidatesTokensDetails ?? [])
      .filter((d) => d.modality === MediaModality.IMAGE)
      .reduce((sum, d) => sum + (d.tokenCount ?? 0), 0),
  }
  return {
    content: [text, ...images].filter(Boolean).join("\n"),
    images,
    tokens,
    cost: getCost(model, tokens),
    stop_reason: result.candidates?.[0].finishReason ?? "",
  }
}
