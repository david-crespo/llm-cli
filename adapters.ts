import OpenAI from "openai"
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses"
import Anthropic from "@anthropic-ai/sdk"
import { GoogleGenAI } from "@google/genai"
import { ValidationError } from "@cliffy/command"

import type { BackgroundStatus, Chat, TokenCounts } from "./types.ts"
import { codeBlock, codeListMd } from "./display.ts"
import { getCost, type Model } from "./models.ts"
import { extname } from "@std/path"

export type ModelResponse = {
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

  return {
    content: response.output_text,
    tokens,
    cost: getCost(model, tokens),
    stop_reason: response.status || "completed",
  }
}

function gptConfig(chatInput: ChatInput): ResponseCreateParamsNonStreaming {
  const { chat, input, model, tools } = chatInput
  return {
    model: model.key,
    input: [
      ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: input },
    ],
    tools: tools.includes("search") ? [{ type: "web_search_preview" as const }] : undefined,
    reasoning: {
      // undefined means medium
      effort: tools.includes("think-high")
        ? "high"
        : tools.includes("no-think")
        ? "none"
        : undefined,
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
  (baseURL: string, envVarName: string) =>
  async ({ chat, input, model, signal }: ChatInput) => {
    const client = new OpenAI({ baseURL, apiKey: Deno.env.get(envVarName) })
    const systemMsg = chat.systemPrompt
      ? [{ role: "system" as const, content: chat.systemPrompt }]
      : []
    const messages = [
      ...systemMsg,
      ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: input },
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

type BashInput = { command: string }
type TextEditorCodeExecInput =
  | { command: "view"; path: string }
  | { command: "create"; path: string; file_text: string }
  | { command: "str_replace"; path: string; old_str: string; new_str: string }

// In theory, tool call data should be stored in structured form and then it's
// the problem of the display layer to do the below. In practice, it's too
// annoying to think about a generic intermediate data format that could hold
// this data, so we're just going to make it a string and deal with it.
function renderClaudeContentBlock(msg: Anthropic.Beta.Messages.BetaContentBlock) {
  if (msg.type === "text") {
    return msg.text
  } else if (msg.type === "server_tool_use") {
    let out = `### Tool call: \`${msg.name}\`\n\n`
    if (msg.name === "bash_code_execution") {
      out += `**Command:** \`${(msg.input as BashInput).command}\``
    } else if (msg.name === "text_editor_code_execution") {
      const input = msg.input as TextEditorCodeExecInput
      if (input.command === "view") {
        out += `**Path:** \`${input.path}\``
      } else if (input.command === "create") {
        const lang = extname(input.path).substring(1)
        out += `**Path:** \`${input.path}\`\n\n${codeBlock(input.file_text, lang)}`
      } else if (input.command === "str_replace") {
        out += [
          `**Path:** \`${input.path}\``,
          `**Old string:** \`${JSON.stringify(input.old_str)}\``,
          `**New string:** \`${JSON.stringify(input.new_str)}\``,
        ].join("\n\n")
      }
    }
    return out
  } else if (
    msg.type.endsWith("_result") && "content" in msg && typeof msg.content === "object"
  ) {
    const c = msg.content as { stdout: string; stderr: string; return_code: number }
    const out = [`**Exit code:** ${c.return_code}`]
    if (c.stdout) out.push(`#### Output\n\n${codeBlock(c.stdout)}`)
    if (c.stderr) out.push(`#### Errors\n\n${codeBlock(c.stderr)}`)
    return out.join("\n\n") || undefined
  }
}

async function claudeCreateMessage(
  { chat, input, image_url, model, tools, signal }: ChatInput,
) {
  const isOpus = model.key === "claude-opus-4-5"

  const think = tools.includes("think")
  const thinkHigh = tools.includes("think-high")
  const noThink = tools.includes("no-think")

  const response = await new Anthropic().beta.messages.create({
    model: model.key,
    system: chat.systemPrompt,
    messages: [
      ...chat.messages.map((m) => claudeMsg(m.role, m.content)),
      claudeMsg("user", input, image_url),
    ],
    max_tokens: tools.includes("think-high") ? 20_000 : 8_000,
    // Opus 4.5 uses effort parameter, other models use budget_tokens
    thinking: isOpus
      ? (think
        ? { type: "enabled" as const, budget_tokens: 4000 }
        : thinkHigh
        ? { type: "enabled" as const, budget_tokens: 16000 }
        : noThink
        ? { type: "disabled" as const }
        : undefined)
      : undefined,
    // For Opus 4.5: high is the default, so only set output_config if user specifies a tool
    output_config: {
      effort: isOpus && noThink ? "low" as const : undefined,
    },
    tools: tools.includes("code")
      ? [{ type: "code_execution_20250825", name: "code_execution" }]
      : undefined,
    betas: ["code-execution-2025-08-25", "effort-2025-11-24"],
  }, { signal })

  const content = response.content.filter((msg) =>
    msg.type === "text" ||
    msg.type === "server_tool_use" ||
    msg.type.endsWith("_result")
  )
    .map(renderClaudeContentBlock)
    .filter((x) => x)
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
    content,
    reasoning,
    tokens,
    cost: getCost(model, tokens),
    stop_reason: response.stop_reason!, // always non-null in non-streaming mode
  }
}

async function geminiCreateMessage({ chat, input, model, tools, signal }: ChatInput) {
  const apiKey = Deno.env.get("GEMINI_API_KEY")
  if (!apiKey) throw Error("GEMINI_API_KEY missing")

  const result = await new GoogleGenAI({ apiKey }).models.generateContent({
    config: {
      thinkingConfig: {
        includeThoughts: true,
      },
      systemInstruction: chat.systemPrompt,
      tools: [
        // always include URL context. it was designed to be used this way
        { urlContext: {} },
        ...(tools.includes("search") ? [{ googleSearch: {} }] : []),
        ...(tools.includes("code") ? [{ codeExecution: {} }] : []),
      ],
      abortSignal: signal,
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
  const costModel = model.id === "gemini-3-pro" && tokens.input > 200_000
    ? { ...model, input: 4.00, output: 18.00 }
    : model

  return {
    content,
    reasoning,
    tokens,
    cost: getCost(costModel, tokens),
    stop_reason: result.candidates?.[0].finishReason || "",
  }
}

type Tool = "search" | "code" | "think" | "think-high" | "no-think"
const providerTools: Record<string, Tool[]> = {
  google: ["search", "code"],
  anthropic: ["think", "think-high", "no-think", "code"],
  // openai models will reason by default. no-think sets effort: minimal
  openai: ["search", "no-think", "think-high"],
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
