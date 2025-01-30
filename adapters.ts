import OpenAI from "npm:openai@4.67"
import Anthropic from "npm:@anthropic-ai/sdk@0.28"
import { GoogleGenerativeAI, type ModelParams } from "npm:@google/generative-ai@0.21"

import type { Chat, TokenCounts } from "./types.ts"
import { models } from "./models.ts"

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
  const content = response.choices[0].message?.content
  if (!content) throw new Error("No response found")
  return {
    content,
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

export function createMessage(input: ChatInput): Promise<ModelResponse> {
  const model = models.find((m) => m.key === input.model)!
  if (model.provider === "anthropic") return claudeCreateMessage(input)
  if (model.provider === "google") return geminiCreateMessage(input)
  if (model.provider === "deepseek") return deepseekCreateMessage(input)
  if (model.provider === "cerebras") return cerebrasCreateMessage(input)
  if (model.provider === "groq") return groqCreateMessage(input)
  return gptCreateMessage(input)
}
