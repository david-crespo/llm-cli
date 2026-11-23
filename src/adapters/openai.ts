import OpenAI, { toFile } from "openai"
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses"
import type { ImageGenerateParamsNonStreaming } from "openai/resources/images"
import { Buffer } from "node:buffer"
import { match, P } from "ts-pattern"

import { ValidationError } from "../errors.ts"
import { parseDataUrl } from "../image-input.ts"
import { postprocessSchemaContent, prepareSchema } from "../schema.ts"
import type { BackgroundStatus, ThinkLevel } from "../types.ts"
import { getCost, type Model } from "../models.ts"
import { saveImage } from "../storage.ts"
import { type ChatInput, imagePrompt, type ModelResponse } from "./types.ts"
import { validateRequestSize } from "./request-size.ts"

function processGptResponse(
  response: OpenAI.Responses.Response,
  model: Model,
  effort: string | undefined,
  wrapped = false,
): ModelResponse {
  const tokens = {
    input: response.usage?.input_tokens || 0,
    output: response.usage?.output_tokens || 0,
    input_cache_hit: response.usage?.input_tokens_details?.cached_tokens || 0,
  }

  const searches = response.output.filter((item) => item.type === "web_search_call").length

  const content = wrapped
    ? postprocessSchemaContent(response.output_text, true)
    : response.output_text

  return {
    content,
    tokens,
    cost: getCost(model, tokens, searches),
    stop_reason: response.status || "completed",
    searches: searches || undefined,
    effort,
    provider: { type: "openai", responseId: response.id },
  }
}

export function openAIEffort(think: ThinkLevel | undefined) {
  return match(think)
    .with("high", () => "high" as const)
    .with("off", () => "none" as const)
    .with("on", P.nullish, () => "medium" as const)
    .exhaustive()
}

function gptConfig(chatInput: ChatInput): {
  params: ResponseCreateParamsNonStreaming
  wrapped: boolean
  effort: string
} {
  const { chat, model, config, outputSchema } = chatInput
  // OpenAI strict mode requires an object root and every property in `required`
  // (see prepareSchema).
  const prep = outputSchema
    ? prepareSchema(outputSchema, { wrapPrimitives: true, allRequired: true })
    : undefined

  // When the last assistant turn came from the OpenAI Responses API, pass its
  // response.id as previous_response_id so encrypted reasoning items carry over
  // and only the new user message is sent.
  // https://developers.openai.com/api/docs/guides/conversation-state
  const lastAssistantMessage = chat.messages.filter((m) => m.role === "assistant").at(-1)
  const previous_response_id = match(lastAssistantMessage?.provider)
    .with({ type: "openai" }, (p) => p.responseId)
    .with(P.nullish, () => undefined)
    .exhaustive()
  const inputMessages = previous_response_id ? chat.messages.slice(-1) : chat.messages

  const effort = openAIEffort(config.think)
  return {
    params: {
      model: model.key,
      input: inputMessages.map((m) => {
        if (m.role === "user" && m.image_urls?.length) {
          return {
            role: "user" as const,
            content: [
              ...(m.content ? [{ type: "input_text" as const, text: m.content }] : []),
              ...m.image_urls.map((image_url) => ({
                type: "input_image" as const,
                image_url,
                detail: "high" as const,
              })),
            ],
          }
        }
        return { role: m.role, content: m.content }
      }),
      previous_response_id,
      // Stable per-chat key so multi-turn requests route to the same backend
      // and hit the prompt cache reliably.
      prompt_cache_key: chat.id,
      tools: config.search ? [{ type: "web_search_preview" as const }] : undefined,
      reasoning: {
        effort,
      },
      instructions: chat.systemPrompt,
      text: prep
        ? {
            format: {
              type: "json_schema",
              name: "output",
              schema: prep.schema,
              strict: true,
            },
          }
        : undefined,
    },
    wrapped: prep?.wrapped ?? false,
    effort,
  }
}

export async function gptCreateMessage(chatInput: ChatInput) {
  const client = new OpenAI({ apiKey: chatInput.apiKey })
  const { params, wrapped, effort } = gptConfig(chatInput)
  validateRequestSize("OpenAI", params)
  const response = await client.responses.create(params, { signal: chatInput.signal })
  return processGptResponse(response, chatInput.model, effort, wrapped)
}

export const gptBg = {
  async initiate(chatInput: ChatInput): Promise<{
    id: string
    status: BackgroundStatus
    effort: string
  }> {
    const client = new OpenAI({ apiKey: chatInput.apiKey })
    const { params, effort } = gptConfig(chatInput)
    const request = {
      ...params,
      background: true,
      store: true,
    }
    validateRequestSize("OpenAI", request)
    const response = await client.responses.create(request)
    return { id: response.id, status: response.status ?? "queued", effort }
  },
  async retrieve(responseId: string, model: Model, apiKey: string): Promise<ModelResponse> {
    const response = await new OpenAI({ apiKey }).responses.retrieve(responseId)
    // Background retrieve: schema wrap info isn't reconstructed here. Structured
    // output via `-b` + `-o` isn't supported yet.
    return processGptResponse(response, model, undefined, false)
  },
  async status(responseId: string, apiKey: string): Promise<BackgroundStatus> {
    const client = new OpenAI({ apiKey })
    const response = await client.responses.retrieve(responseId)
    if (!response.status) throw new Error("Missing status for background response")
    return response.status
  },
  async cancel(responseId: string, apiKey: string): Promise<void> {
    const client = new OpenAI({ apiKey })
    await client.responses.cancel(responseId)
  },
}

const OPENAI_EDIT_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
}

const OPENAI_EDIT_MAX_IMAGES = 16
const OPENAI_EDIT_MAX_BYTES = 50 * 1_000_000

async function imageToUploadable(imageUrl: string, index: number, signal?: AbortSignal) {
  let bytes: Uint8Array
  let mediaType: string
  const parsed = parseDataUrl(imageUrl)
  if (parsed) {
    bytes = Buffer.from(parsed.data, "base64")
    mediaType = parsed.mediaType
  } else {
    const res = await fetch(imageUrl, { signal })
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`)
    bytes = new Uint8Array(await res.arrayBuffer())
    mediaType =
      res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "image/png"
  }
  const ext = OPENAI_EDIT_EXT[mediaType]
  if (!ext) {
    throw new ValidationError(
      `OpenAI image editing only supports PNG, JPEG, and WebP (got ${mediaType})`,
    )
  }
  if (bytes.byteLength > OPENAI_EDIT_MAX_BYTES) {
    const size = (bytes.byteLength / 1_000_000).toFixed(2)
    throw new ValidationError(
      `OpenAI image edit input is larger than the 50 MB limit (${size} MB)`,
    )
  }
  return toFile(bytes, `image-${index}.${ext}`, { type: mediaType })
}

export function gptImageParams({ chat, model, imageOptions }: ChatInput) {
  const { prompt } = imagePrompt(chat)
  return {
    model: model.key,
    prompt,
    n: 1,
    // Kitty graphics can only display PNG directly
    output_format: "png" as const,
    quality: imageOptions?.quality,
    size: imageOptions?.size,
  } satisfies ImageGenerateParamsNonStreaming
}

export function processGptImageResponse(
  response: OpenAI.ImagesResponse,
  model: Model,
  save: (bytes: Uint8Array, index: number) => string,
): ModelResponse {
  const images = (response.data ?? []).flatMap((d, i) =>
    d.b64_json ? [save(Buffer.from(d.b64_json, "base64"), i)] : [],
  )
  if (images.length === 0) throw new Error("No image in response")
  // Image models don't report cached input, and all input tokens are priced at
  // the model's input rate.
  const tokens = {
    input: response.usage?.input_tokens ?? 0,
    output: response.usage?.output_tokens ?? 0,
  }
  return {
    content: images.join("\n"),
    images,
    tokens,
    cost: getCost(model, tokens),
    stop_reason: "completed",
    // Actual quality used (e.g., when quality was "auto")
    effort: response.quality,
  }
}

export async function gptImageCreateMessage(chatInput: ChatInput): Promise<ModelResponse> {
  const { prompt, imageUrls } = imagePrompt(chatInput.chat)
  const params = gptImageParams(chatInput)
  const client = new OpenAI({ apiKey: chatInput.apiKey })
  let response: OpenAI.ImagesResponse
  if (imageUrls.length > 0) {
    if (imageUrls.length > OPENAI_EDIT_MAX_IMAGES) {
      throw new ValidationError(
        `OpenAI image editing accepts at most ${OPENAI_EDIT_MAX_IMAGES} images (got ${imageUrls.length})`,
      )
    }
    const files = await Promise.all(
      imageUrls.map((url, i) => imageToUploadable(url, i, chatInput.signal)),
    )
    response = await client.images.edit(
      { ...params, image: files.length === 1 ? files[0] : files },
      { signal: chatInput.signal },
    )
  } else {
    response = await client.images.generate(params, { signal: chatInput.signal })
  }
  return processGptImageResponse(response, chatInput.model, (bytes, i) =>
    saveImage(bytes, prompt, "png", i),
  )
}

const makeOpenAIFunc =
  (baseURL: string) =>
  async ({ chat, model, apiKey, signal, outputSchema }: ChatInput) => {
    const client = new OpenAI({ baseURL, apiKey })
    const systemMsg = chat.systemPrompt
      ? [{ role: "system" as const, content: chat.systemPrompt }]
      : []
    const messages = [
      ...systemMsg,
      ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
    ]
    // Use the same strict-mode schema shape as gptConfig across OpenRouter
    // providers.
    const prep = outputSchema
      ? prepareSchema(outputSchema, { wrapPrimitives: true, allRequired: true })
      : undefined
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: model.key,
      messages,
      response_format: prep
        ? {
            type: "json_schema",
            json_schema: { name: "output", schema: prep.schema, strict: true },
          }
        : undefined,
    }
    const response = await client.chat.completions.create(params, { signal })
    const message = response.choices[0].message
    if (!message) throw new Error("No response found")

    let reasoning =
      "reasoning_content" in message && typeof message.reasoning_content === "string"
        ? message.reasoning_content
        : ""

    let content = message.content || ""

    // extract reasoning from think tags. opening tag is optional because
    // cerebras leaves it out, the maniacs
    const thinkMatch = /(<think>)?(.+)<\/think>\s+(.+)/ms.exec(content)
    if (thinkMatch) {
      // shouldn't be both reasoning_content and <think> but handle it just in case
      reasoning = reasoning ? reasoning + "\n\n" + thinkMatch[2] : thinkMatch[2]
      content = thinkMatch[3]
    }

    // grok does not include reasoning tokens in completion_tokens. deepseek does
    let output = response.usage?.completion_tokens || 0
    if (model.key.startsWith("grok")) {
      output += response.usage?.completion_tokens_details?.reasoning_tokens || 0
    }

    const tokens = {
      input: response.usage?.prompt_tokens || 0,
      output,
      input_cache_hit: response.usage?.prompt_tokens_details?.cached_tokens || 0,
    }
    return {
      content: prep ? postprocessSchemaContent(content, prep.wrapped) : content,
      reasoning,
      tokens,
      cost: getCost(model, tokens),
      stop_reason: response.choices[0].finish_reason,
    }
  }

export const openrouterCreateMessage = makeOpenAIFunc("https://openrouter.ai/api/v1")
