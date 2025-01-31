import OpenAI from "npm:openai@4.81.0"
import Anthropic from "npm:@anthropic-ai/sdk@0.36.3"
import { GoogleGenerativeAI, type ModelParams } from "npm:@google/generative-ai@0.21"
import { ValidationError } from "jsr:@cliffy/command@1.0.0-rc.7"

import type { Chat, TokenCounts } from "./types.ts"
import { codeListMd } from "./display.ts"

type ModelResponse = {
  content: string
  tokens: TokenCounts
  stop_reason: string
}

type ChatInput = {
  chat: Chat
  input: string
  model: string
  tools: string[]
}

const makeOpenAIFunc = (client: OpenAI) => async ({ chat, input, model }: ChatInput) => {
  const systemMsg = chat.systemPrompt
    ? [{
      role: model.startsWith("o1") ? "user" as const : "system" as const,
      content: chat.systemPrompt,
    }]
    : []
  const messages = [
    ...systemMsg,
    ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: input },
  ]
  const response = await client.chat.completions.create({ model, messages })
  const message = response.choices[0].message
  if (!message) throw new Error("No response found")
  const reasoning_content =
    "reasoning_content" in message && typeof message.reasoning_content === "string"
      ? message.reasoning_content + "\n\n"
      : ""
  return {
    content: reasoning_content + (message.content || ""),
    tokens: {
      input: response.usage?.prompt_tokens || 0,
      output: response.usage?.completion_tokens || 0,
      input_cache_hit: response.usage?.prompt_tokens_details?.cached_tokens || 0,
    },
    stop_reason: response.choices[0].finish_reason,
  }
}

const gptCreateMessage = makeOpenAIFunc(new OpenAI())

const groqCreateMessage = makeOpenAIFunc(
  new OpenAI({
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: Deno.env.get("GROQ_API_KEY"),
  }),
)

const deepseekCreateMessage = makeOpenAIFunc(
  new OpenAI({
    baseURL: "https://api.deepseek.com",
    apiKey: Deno.env.get("DEEPSEEK_API_KEY"),
  }),
)

export const cerebrasCreateMessage = makeOpenAIFunc(
  new OpenAI({
    baseURL: "https://api.cerebras.ai/v1",
    apiKey: Deno.env.get("CEREBRAS_API_KEY"),
  }),
)

async function claudeCreateMessage({ chat, input, model }: ChatInput) {
  const response = await new Anthropic().messages.create({
    model,
    system: chat.systemPrompt,
    messages: [
      ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: input },
    ],
    max_tokens: 4096,
  })
  const respMsg = response.content[0]
  return {
    // we're not doing tool use yet, so the response will always be text
    content: respMsg.type === "text" ? respMsg.text : JSON.stringify(respMsg),
    tokens: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    },
    stop_reason: response.stop_reason!, // always non-null in non-streaming mode
  }
}

async function geminiCreateMessage({ chat, input, model, tools }: ChatInput) {
  const key = Deno.env.get("GEMINI_API_KEY")
  if (!key) throw Error("GEMINI_API_KEY missing")

  const params: ModelParams = { model }
  if (tools && tools.length > 0) {
    params.tools = []
    // @ts-expect-error googleSearch is real, the types are wrong
    if (tools.includes("search")) params.tools.push({ googleSearch: {} })
    if (tools.includes("code")) params.tools.push({ codeExecution: {} })
  } else {
    // code seems incompatible with a system prompt. search isn't, but it's too
    // concise with the system prompt, so we'll leave it off there too
    params.systemInstruction = chat.systemPrompt
  }

  const result = await new GoogleGenerativeAI(key).getGenerativeModel(params)
    .startChat({
      history: chat.messages.map((msg) => ({
        // gemini uses model instead of assistant
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      })),
    }).sendMessage(input)

  return {
    content: result.response.text(),
    tokens: {
      input: result.response.usageMetadata!.promptTokenCount,
      output: result.response.usageMetadata!.candidatesTokenCount,
    },
    stop_reason: result.response.candidates?.[0].finishReason || "",
  }
}

type Tool = "search" | "code"
const toolKeys: Tool[] = ["search", "code"]

export function parseTools(provider: string, tools: string[]): Tool[] {
  if (tools.length === 0) return []
  if (provider !== "google") {
    throw new ValidationError("Tools can only be used with Gemini models")
  }
  const badTools = tools.filter((t) => !(toolKeys as string[]).includes(t))
  if (badTools.length > 0) {
    throw new ValidationError(
      `Invalid tools: ${codeListMd(badTools)}. Valid values are: ${codeListMd(toolKeys)}`,
    )
  }
  return tools as Tool[]
}

export function createMessage(provider: string, input: ChatInput): Promise<ModelResponse> {
  if (provider === "anthropic") return claudeCreateMessage(input)
  if (provider === "google") return geminiCreateMessage(input)
  if (provider === "deepseek") return deepseekCreateMessage(input)
  if (provider === "cerebras") return cerebrasCreateMessage(input)
  if (provider === "groq") return groqCreateMessage(input)
  return gptCreateMessage(input)
}
