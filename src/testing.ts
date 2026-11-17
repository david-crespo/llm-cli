import assert from "node:assert/strict"

import { type Model, models } from "./models.ts"
import type { Chat } from "./types.ts"

/**
 * An `assert.throws`/`assert.rejects` validator for an instance of `type` whose
 * message includes `text`. Node's own third argument is the failure message,
 * not a substring to match.
 */
export function errorIncluding(type: abstract new (...args: never) => Error, text: string) {
  return (e: unknown) => {
    assert(e instanceof type, `Expected ${type.name}, got ${e}`)
    assert(e.message.includes(text), `Expected "${e.message}" to include "${text}"`)
    return true
  }
}

export function assertAlmostEqual(actual: number, expected: number, tolerance = 1e-7) {
  assert(
    Math.abs(actual - expected) < tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  )
}

/**
 * The first catalog model from `provider` of `kind` (text when omitted), so
 * tests don't break when a model is renamed or replaced.
 */
export function testModel(provider: string, kind?: Model["kind"]): Model {
  const model = models.find((m) => m.provider === provider && m.kind === kind)
  assert(model, `No ${kind ?? "text"} model for ${provider}`)
  return model
}

/** Replace `globalThis.fetch` with `handler` while `fn` runs. */
export async function withFetch<T>(
  handler: typeof fetch,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

type Block = { type: string; [key: string]: unknown }

/** Stream deltas that build up each final block the way the API sends them */
function blockDeltas(block: Block) {
  switch (block.type) {
    case "text": {
      const citations = (block.citations ?? []) as unknown[]
      return {
        start: { ...block, text: "", citations: null },
        deltas: [
          { type: "text_delta", text: block.text },
          ...citations.map((citation) => ({ type: "citations_delta", citation })),
        ],
      }
    }
    case "thinking":
      return {
        start: { ...block, thinking: "", signature: "" },
        deltas: [
          { type: "thinking_delta", thinking: block.thinking },
          { type: "signature_delta", signature: block.signature },
        ],
      }
    case "server_tool_use":
      return {
        start: { ...block, input: {} },
        deltas: [{ type: "input_json_delta", partial_json: JSON.stringify(block.input) }],
      }
    default:
      return { start: block, deltas: [] }
  }
}

/**
 * A streamed Claude response as server-sent events. `usage` has the
 * `message_start` counts; output tokens and server tool use arrive at the end.
 */
export function claudeStream(
  content: Block[] = [{ type: "text", text: "ok" }],
  {
    output_tokens = 0,
    server_tool_use,
    ...usage
  }: Record<string, unknown> & { output_tokens?: number } = {},
) {
  const events = [
    {
      type: "message_start",
      message: { content: [], usage: { input_tokens: 0, output_tokens: 0, ...usage } },
    },
    ...content.flatMap((block, index) => {
      const { start, deltas } = blockDeltas(block)
      return [
        { type: "content_block_start", index, content_block: start },
        ...deltas.map((delta) => ({ type: "content_block_delta", index, delta })),
        { type: "content_block_stop", index },
      ]
    }),
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens, server_tool_use },
    },
    { type: "message_stop" },
  ]
  return new Response(
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

/**
 * An OpenAI Responses API reply with `text` as its output message, after any
 * `toolCalls` output items
 */
export const openaiResponse = (
  text = "ok",
  { toolCalls = [], ...fields }: Record<string, unknown> & { toolCalls?: unknown[] } = {},
) =>
  Response.json({
    // The SDK only fills in output_text for this object type
    object: "response",
    id: "response",
    status: "completed",
    output: [
      ...toolCalls,
      {
        type: "message",
        id: "msg",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    ...fields,
  })

/**
 * A Gemini generateContent reply with these parts in its one candidate.
 * `usageMetadata` goes on the response, other fields on the candidate.
 */
export const geminiResponse = (
  parts: unknown[] = [{ text: "ok" }],
  { usageMetadata, ...candidate }: Record<string, unknown> = {},
) =>
  Response.json({
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP", ...candidate }],
    usageMetadata,
  })

/** Run `fn` with every request answered by `respond()`, recording the JSON bodies sent */
export async function recordRequests<T>(respond: () => Response, fn: () => Promise<T>) {
  const bodies: Record<string, unknown>[] = []
  const result = await withFetch(async (input, init) => {
    bodies.push((await new Request(input, init).json()) as Record<string, unknown>)
    return respond()
  }, fn)
  return { result, bodies }
}

/** A new chat with one user message */
export const promptChat = (content: string): Chat => ({
  id: "test",
  createdAt: new Date(0),
  systemPrompt: "test",
  messages: [{ role: "user", content, createdAt: new Date(0) }],
})
