import OpenAI from "openai"
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses"
import Anthropic from "@anthropic-ai/sdk"
import { GoogleGenAI, ThinkingLevel } from "@google/genai"
import { ValidationError } from "@cliffy/command"

import * as R from "remeda"

import type { BackgroundStatus, Chat, TokenCounts } from "./types.ts"
import { getCost, type Model } from "./models.ts"

export type ModelResponse = {
  content: string
  tokens: TokenCounts
  stop_reason: string
  cost: number
  searches?: number
}

export type ThinkLevel = "on" | "high" | "off" | undefined

export type ToolConfig = {
  search: boolean
  think: ThinkLevel
}

export type ChatInput = {
  chat: Chat
  model: Model
  config: ToolConfig
  signal?: AbortSignal
}

function processGptResponse(
  response: OpenAI.Responses.Response,
  model: Model,
): ModelResponse {
  const tokens = {
    input: response.usage?.input_tokens || 0,
    output: response.usage?.output_tokens || 0,
    input_cache_hit: response.usage?.input_tokens_details?.cached_tokens || 0,
  }

  const searches = response.output.filter((item) => item.type === "web_search_call").length

  return {
    content: response.output_text,
    tokens,
    cost: getCost(model, tokens, searches),
    stop_reason: response.status || "completed",
    searches: searches || undefined,
  }
}

function gptConfig(chatInput: ChatInput): ResponseCreateParamsNonStreaming {
  const { chat, model, config } = chatInput
  return {
    model: model.key,
    input: chat.messages.map((m) => ({ role: m.role, content: m.content })),
    tools: config.search ? [{ type: "web_search_preview" as const }] : undefined,
    reasoning: {
      effort: config.think === "high" ? "high" : config.think === "off" ? "none" : "medium",
    },
    instructions: chat.systemPrompt,
  }
}

async function gptCreateMessage(chatInput: ChatInput) {
  const client = new OpenAI()
  const response = await client.responses.create(
    gptConfig(chatInput),
    { signal: chatInput.signal },
  )
  return processGptResponse(response, chatInput.model)
}

export const gptBg = {
  async initiate(chatInput: ChatInput): Promise<{ id: string; status: BackgroundStatus }> {
    const client = new OpenAI()
    const response = await client.responses.create({
      ...gptConfig(chatInput),
      background: true,
      store: true,
    })
    return { id: response.id, status: response.status ?? "queued" }
  },
  async retrieve(responseId: string, model: Model): Promise<ModelResponse> {
    const response = await new OpenAI().responses.retrieve(responseId)
    return processGptResponse(response, model)
  },
  async status(responseId: string): Promise<BackgroundStatus> {
    const client = new OpenAI()
    const response = await client.responses.retrieve(responseId)
    if (!response.status) throw new Error("Missing status for background response")
    return response.status
  },
  async cancel(responseId: string): Promise<void> {
    const client = new OpenAI()
    await client.responses.cancel(responseId)
  },
}

const makeOpenAIFunc =
  (baseURL: string, envVarName: string) => async ({ chat, model, signal }: ChatInput) => {
    const client = new OpenAI({ baseURL, apiKey: Deno.env.get(envVarName) })
    const systemMsg = chat.systemPrompt
      ? [{ role: "system" as const, content: chat.systemPrompt }]
      : []
    const messages = [
      ...systemMsg,
      ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
    ]
    const response = await client.chat.completions.create(
      { model: model.key, messages },
      { signal },
    )
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
      content,
      reasoning,
      tokens,
      cost: getCost(model, tokens),
      stop_reason: response.choices[0].finish_reason,
    }
  }

export const groqCreateMessage = makeOpenAIFunc(
  "https://api.groq.com/openai/v1",
  "GROQ_API_KEY",
)

const deepseekCreateMessage = makeOpenAIFunc(
  "https://api.deepseek.com",
  "DEEPSEEK_API_KEY",
)

export const cerebrasCreateMessage = makeOpenAIFunc(
  "https://api.cerebras.ai/v1",
  "CEREBRAS_API_KEY",
)

export const grokCreateMessage = makeOpenAIFunc(
  "https://api.x.ai/v1",
  "XAI_API_KEY",
)

export const openrouterCreateMessage = makeOpenAIFunc(
  "https://openrouter.ai/api/v1",
  "OPENROUTER_API_KEY",
)

function claudeMsg(
  role: "user" | "assistant",
  text: string,
  image_url?: string,
): Anthropic.MessageParam {
  const content: Anthropic.ContentBlockParam[] = [{ type: "text", text }]

  if (image_url) {
    content.unshift({
      type: "image",
      source: { type: "url", url: image_url },
    })
  }

  return { role, content }
}

function renderClaudeContentBlock(msg: Anthropic.Beta.Messages.BetaContentBlock) {
  if (msg.type === "text") {
    const citations = (msg.citations || [])
      .filter((c) => c.type === "web_search_result_location")
    if (citations.length === 0) return msg.text
    const unique = R.uniqueBy(citations, (c) => c.url)
    const sources = unique.map((c) => `[${c.title || c.url}](${c.url})`).join(" · ")
    return msg.text + " (" + sources + ")"
  } else if (msg.type === "server_tool_use" && msg.name === "web_search") {
    return `**Search:** ${(msg.input as { query: string }).query}`
  } else if (msg.type === "server_tool_use" && msg.name === "web_fetch") {
    return `**Fetch:** ${(msg.input as { url: string }).url}`
  }
}

async function claudeCreateMessage(
  { chat, model, config, signal }: ChatInput,
) {
  // Haiku doesn't support effort; Opus/Sonnet use effort + adaptive thinking
  const supportsEffort = !model.key.includes("haiku")

  const toolsList: Anthropic.Beta.BetaToolUnion[] = []
  if (config.search) {
    toolsList.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 })
    toolsList.push({ type: "web_fetch_20260209", name: "web_fetch" })
    toolsList.push({ type: "code_execution_20260120", name: "code_execution" })
  }

  const response = await new Anthropic().beta.messages.create({
    model: model.key,
    cache_control: { type: "ephemeral" },
    system: chat.systemPrompt,
    messages: chat.messages.map((m) =>
      claudeMsg(m.role, m.content, m.role === "user" ? m.image_url : undefined)
    ),
    max_tokens: config.think === "high" ? 20_000 : 8_000,
    // Opus/Sonnet use effort + adaptive thinking; Haiku uses budget_tokens
    thinking: supportsEffort
      ? config.think === "off"
        ? { type: "disabled" as const }
        : config.think !== undefined
        ? { type: "adaptive" as const }
        : undefined
      : config.think === "on"
      ? { type: "enabled" as const, budget_tokens: 4000 }
      : config.think === "high"
      ? { type: "enabled" as const, budget_tokens: 16000 }
      : config.think === "off"
      ? { type: "disabled" as const }
      : undefined,
    output_config: supportsEffort
      ? {
        effort: config.think === "on"
          ? "medium" as const
          : config.think === "high"
          ? "high" as const
          : config.think === "off"
          ? "low" as const
          : undefined,
      }
      : undefined,
    tools: toolsList.length > 0 ? toolsList : undefined,
    betas: ["code-execution-web-tools-2026-02-09"],
  }, { signal })

  const searches = response.usage.server_tool_use?.web_search_requests ?? 0

  const blocks = response.content.filter((msg) =>
    msg.type === "text" || msg.type === "server_tool_use"
  )
    .map(renderClaudeContentBlock)
    .filter((x): x is string => !!x)

  // Join blocks, avoiding separators around punctuation/connectors
  const content = blocks.reduce((acc, block) => {
    if (!acc) return block
    if (/^[,;.!?]/.test(block)) return acc + block // no space before punctuation
    if (/^(and|or)\b/i.test(block)) return acc + " " + block // space before connectors
    return acc + "\n\n" + block
  }, "")
  const reasoning = response.content
    .filter((msg) => msg.type === "thinking")
    .map((msg) => msg.thinking)
    .join("\n\n")

  // unlike openapi, input_tokens is only cache misses
  const cache_miss = response.usage.input_tokens || 0
  const cache_hit = response.usage.cache_read_input_tokens || 0
  const cache_write = response.usage.cache_creation_input_tokens || 0

  const tokens = {
    // technically, cache writes cost 25% more than regular input tokens but I
    // don't want to build in the logic to count it
    input: cache_miss + cache_hit + cache_write,
    output: response.usage.output_tokens,
    input_cache_hit: cache_hit,
  }

  return {
    content,
    reasoning,
    tokens,
    cost: getCost(model, tokens, searches),
    stop_reason: response.stop_reason!, // always non-null in non-streaming mode
    searches: searches || undefined,
  }
}

async function geminiCreateMessage({ chat, model, config, signal }: ChatInput) {
  const apiKey = Deno.env.get("GEMINI_API_KEY")
  if (!apiKey) throw Error("GEMINI_API_KEY missing")

  const isFlash = model.key.includes("flash")

  const result = await new GoogleGenAI({ apiKey }).models.generateContent({
    config: {
      // https://ai.google.dev/gemini-api/docs/thinking
      thinkingConfig: {
        includeThoughts: true,
        thinkingLevel: config.think === "high"
          ? ThinkingLevel.HIGH
          : config.think === "on"
          ? ThinkingLevel.MEDIUM
          : config.think === "off"
          // Flash supports "minimal", Pro only goes down to "low"
          ? (isFlash ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW)
          : undefined, // default to dynamic
      },
      systemInstruction: chat.systemPrompt,
      tools: [
        // always include URL context. it was designed to be used this way
        { urlContext: {} },
        ...(config.search ? [{ googleSearch: {} }] : []),
      ],
      abortSignal: signal,
    },
    model: model.key,
    contents: chat.messages.map((msg) => ({
      // gemini uses model instead of assistant
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
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

  content += searchResultsMd

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

export const searchProviders = new Set(["anthropic", "openai", "google"])
export const thinkProviders = new Set(["anthropic", "openai", "google"])

export function validateConfig(provider: string, config: ToolConfig) {
  if (config.search && !searchProviders.has(provider)) {
    throw new ValidationError(`Search not supported for ${provider}`)
  }
  if (config.think !== undefined && !thinkProviders.has(provider)) {
    throw new ValidationError(`Thinking control not supported for ${provider}`)
  }
}

export function createMessage(input: ChatInput): Promise<ModelResponse> {
  const { provider } = input.model
  if (provider === "anthropic") return claudeCreateMessage(input)
  if (provider === "google") return geminiCreateMessage(input)
  if (provider === "deepseek") return deepseekCreateMessage(input)
  if (provider === "cerebras") return cerebrasCreateMessage(input)
  if (provider === "groq") return groqCreateMessage(input)
  if (provider === "xai") return grokCreateMessage(input)
  if (provider === "openrouter") return openrouterCreateMessage(input)
  return gptCreateMessage(input)
}
