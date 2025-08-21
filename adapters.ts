import OpenAI from "npm:openai@5.12.1"
import Anthropic from "npm:@anthropic-ai/sdk@0.39.0"
import { GoogleGenAI } from "npm:@google/genai@1.15.0"
import { ValidationError } from "jsr:@cliffy/command@1.0.0-rc.7"
import * as R from "npm:remeda@2.19"

import type { Chat, TokenCounts } from "./types.ts"
import { codeListMd } from "./display.ts"
import { getCost, type Model } from "./models.ts"

type ModelResponse = {
  content: string
  tokens: TokenCounts
  stop_reason: string
  cost: number
}

export type ChatInput = {
  chat: Chat
  input: string
  image_url?: string | undefined
  model: Model
  tools: string[]
}

const makeOpenAIResponsesFunc =
  (client: OpenAI) => async ({ chat, input, model, tools }: ChatInput) => {
    const response = await client.responses.create({
      model: model.key,
      input: [
        ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: input },
      ],
      tools: tools.includes("search")
        ? [{ type: "web_search_preview" as const }]
        : undefined,
      reasoning: {
        effort: tools.includes("think") || model.id === "gpt-5-thinking"
          ? "medium"
          : "minimal",
      },
      instructions: chat.systemPrompt,
    })

    const tokens = {
      input: response.usage?.input_tokens || 0,
      output: response.usage?.output_tokens || 0,
      // @ts-expect-error openai client types are wrong, it's there
      input_cache_hit: R.pathOr(response, [
        "usage",
        "input_tokens_details",
        "cached_tokens",
      ], 0) as number,
    }
    // Haven't been able to get it to give me a reasoning summary, so I don't
    // know how those are integrated into output_text. For now, don't bother
    // processing reasoning tokens explicitly at all. Might be nice to add a
    // token count for reasoning tokens.

    return {
      content: response.output_text,
      tokens,
      cost: getCost(model, tokens),
      stop_reason: response.status || "completed",
    }
  }

const makeOpenAIFunc =
  (baseURL: string, envVarName: string) => async ({ chat, input, model }: ChatInput) => {
    const client = new OpenAI({ baseURL, apiKey: Deno.env.get(envVarName) })
    const systemMsg = chat.systemPrompt
      ? [{ role: "system" as const, content: chat.systemPrompt }]
      : []
    const messages = [
      ...systemMsg,
      ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: input },
    ]
    const response = await client.chat.completions.create({ model: model.key, messages })
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

const gptCreateMessage = makeOpenAIResponsesFunc(new OpenAI())

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

async function claudeCreateMessage(
  { chat, input, image_url, model, tools }: ChatInput,
) {
  const think = tools.length > 0 && tools.includes("think")

  const response = await new Anthropic().messages.create({
    model: model.key,
    system: chat.systemPrompt,
    messages: [
      ...chat.messages.map((m) => claudeMsg(m.role, m.content)),
      claudeMsg("user", input, image_url),
    ],
    max_tokens: 4096,
    thinking: think ? { "type": "enabled", budget_tokens: 1024 } : undefined,
  })
  const content = response.content
    .filter((msg) => msg.type === "text")
    .map((msg) => msg.text)
    .join("\n\n")
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
    // we're not doing tool use yet, so the response will always be text
    content,
    reasoning,
    tokens,
    cost: getCost(model, tokens),
    stop_reason: response.stop_reason!, // always non-null in non-streaming mode
  }
}

async function geminiCreateMessage({ chat, input, model, tools }: ChatInput) {
  const apiKey = Deno.env.get("GEMINI_API_KEY")
  if (!apiKey) throw Error("GEMINI_API_KEY missing")

  const think = model.id.includes("pro") || tools.includes("think")
  const result = await new GoogleGenAI({ apiKey }).models.generateContent({
    config: {
      thinkingConfig: {
        thinkingBudget: think ? undefined : 0,
        includeThoughts: true,
      },
      systemInstruction: chat.systemPrompt,
      tools: [
        // always include URL context. it was designed to be used this way
        { urlContext: {} },
        ...(tools.includes("search") ? [{ googleSearch: {} }] : []),
        ...(tools.includes("code") ? [{ codeExecution: {} }] : []),
      ],
    },
    model: model.key,
    contents: [
      ...chat.messages.map((msg) => ({
        // gemini uses model instead of assistant
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      })),
      { role: "user", parts: [{ text: input }] },
    ],
  })

  // console.log(JSON.stringify(result, null, 2))

  const parts = result.candidates?.[0].content?.parts ?? []
  const reasoning = parts.filter((p) => p.text && p.thought).map((p) => p.text!).join(
    "\n\n",
  )
  let content = parts.filter((p) => p.text && !p.thought).map((p) => p.text!).join("\n\n")

  const searchResults = result.candidates?.[0].groundingMetadata?.groundingChunks
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
  const costModel = model.id === "gemini-2.5-pro" && tokens.input > 200_000
    ? { ...model, input: 2.50, output: 15 }
    : model

  return {
    content,
    reasoning,
    tokens,
    cost: getCost(costModel, tokens),
    stop_reason: result.candidates?.[0].finishReason || "",
  }
}

type Tool = "search" | "code" | "think"
const providerTools: Record<string, Tool[]> = {
  google: ["search", "code", "think"],
  anthropic: ["think"],
  openai: ["search", "think"],
}

function checkTools(provider: string, inputTools: string[]) {
  const allowedTools = providerTools[provider]
  const badTools = inputTools.filter((t) => !(allowedTools as string[]).includes(t))
  if (badTools.length > 0) {
    throw new ValidationError(
      `Invalid tools: ${
        codeListMd(badTools)
      }. Valid tools for ${provider} models are: ${allowedTools}`,
    )
  }
}

export function parseTools(provider: string, tools: string[]): Tool[] {
  if (tools.length === 0) return []

  if (!(provider in providerTools)) {
    throw new ValidationError("Tools can only be used with Google and Anthropic models")
  }
  checkTools(provider, tools)
  return tools as Tool[]
}

export function createMessage(provider: string, input: ChatInput): Promise<ModelResponse> {
  if (provider === "anthropic") return claudeCreateMessage(input)
  if (provider === "google") return geminiCreateMessage(input)
  if (provider === "deepseek") return deepseekCreateMessage(input)
  if (provider === "cerebras") return cerebrasCreateMessage(input)
  if (provider === "groq") return groqCreateMessage(input)
  if (provider === "xai") return grokCreateMessage(input)
  if (provider === "openrouter") return openrouterCreateMessage(input)
  return gptCreateMessage(input)
}
