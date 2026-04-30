import OpenAI from "openai"
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses"
import { match, P } from "ts-pattern"

import { postprocessSchemaContent, prepareSchema } from "../schema.ts"
import type { BackgroundStatus } from "../types.ts"
import { getCost, type Model } from "../models.ts"
import type { ChatInput, ModelResponse } from "./types.ts"

function processGptResponse(
  response: OpenAI.Responses.Response,
  model: Model,
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
    provider: { type: "openai", responseId: response.id },
  }
}

function gptConfig(
  chatInput: ChatInput,
): { params: ResponseCreateParamsNonStreaming; wrapped: boolean } {
  const { chat, model, config, outputSchema } = chatInput
  // OpenAI strict mode has two quirks the other providers don't impose:
  //   1. Root schema must be `object` — primitives, unions, and arrays at the
  //      top level are rejected. `wrapPrimitives` wraps non-object roots as
  //      `{ value: <schema> }`; the response is unwrapped in postprocess.
  //   2. Every property must appear in `required` — optional fields are not
  //      allowed. `allRequired` forces all keys into `required`.
  // We keep strict mode on because it's what makes structured output reliable.
  const prep = outputSchema
    ? prepareSchema(outputSchema, { wrapPrimitives: true, allRequired: true })
    : undefined

  // If the most recent assistant turn was an OpenAI Responses call we have its
  // response.id — chain via previous_response_id so encrypted reasoning items
  // carry over and we only need to send the new user message.
  // https://developers.openai.com/api/docs/guides/conversation-state
  const lastAssistantMessage = chat.messages
    .filter((m) => m.role === "assistant")
    .at(-1)
  const previous_response_id = match(lastAssistantMessage?.provider)
    .with({ type: "openai" }, (p) => p.responseId)
    .with(P.nullish, () => undefined)
    .exhaustive()
  const inputMessages = previous_response_id ? chat.messages.slice(-1) : chat.messages

  return {
    params: {
      model: model.key,
      input: inputMessages.map((m) => ({ role: m.role, content: m.content })),
      previous_response_id,
      // Stable per-chat key so multi-turn requests route to the same backend
      // and hit the prompt cache reliably.
      prompt_cache_key: chat.id,
      tools: config.search ? [{ type: "web_search_preview" as const }] : undefined,
      reasoning: {
        effort: match(config.think)
          .with("high", () => "high" as const)
          .with("off", () => "none" as const)
          .with("on", P.nullish, () => "medium" as const)
          .exhaustive(),
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
  }
}

export async function gptCreateMessage(chatInput: ChatInput) {
  const client = new OpenAI()
  const { params, wrapped } = gptConfig(chatInput)
  const response = await client.responses.create(params, { signal: chatInput.signal })
  return processGptResponse(response, chatInput.model, wrapped)
}

export const gptBg = {
  async initiate(chatInput: ChatInput): Promise<{ id: string; status: BackgroundStatus }> {
    const client = new OpenAI()
    const { params } = gptConfig(chatInput)
    const response = await client.responses.create({
      ...params,
      background: true,
      store: true,
    })
    return { id: response.id, status: response.status ?? "queued" }
  },
  async retrieve(responseId: string, model: Model): Promise<ModelResponse> {
    const response = await new OpenAI().responses.retrieve(responseId)
    // Background retrieve: schema wrap info isn't reconstructed here. Structured
    // output via `-b` + `-o` isn't supported yet.
    return processGptResponse(response, model, false)
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
  async ({ chat, model, signal, outputSchema }: ChatInput) => {
    const client = new OpenAI({ baseURL, apiKey: Deno.env.get(envVarName) })
    const systemMsg = chat.systemPrompt
      ? [{ role: "system" as const, content: chat.systemPrompt }]
      : []
    const messages = [
      ...systemMsg,
      ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
    ]
    // Same strict-mode shape as the OpenAI Responses path (see gptConfig):
    // object-only roots and all-properties-required. Third-party compatible
    // providers vary in how strictly they enforce this, but matching OpenAI's
    // shape keeps behavior consistent without a per-provider matrix.
    const prep = outputSchema
      ? prepareSchema(outputSchema, { wrapPrimitives: true, allRequired: true })
      : undefined
    const response = await client.chat.completions.create({
      model: model.key,
      messages,
      response_format: prep
        ? {
          type: "json_schema",
          json_schema: { name: "output", schema: prep.schema, strict: true },
        }
        : undefined,
    }, { signal })
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

export const groqCreateMessage = makeOpenAIFunc(
  "https://api.groq.com/openai/v1",
  "GROQ_API_KEY",
)

export const deepseekCreateMessage = makeOpenAIFunc(
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
