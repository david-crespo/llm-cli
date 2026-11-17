import assert from "node:assert/strict"
import { test } from "node:test"
import { Buffer } from "node:buffer"
import { type } from "arktype"

import {
  errorIncluding,
  openaiResponse,
  promptChat,
  recordRequests,
  testModel,
} from "../testing.ts"
import type { ThinkLevel } from "../types.ts"
import { createMessage } from "./index.ts"
import { gptImageParams, openAIEffort, processGptImageResponse } from "./openai.ts"
import type { ChatInput } from "./types.ts"

test("OpenAI reasoning intent resolves to native effort", () => {
  const cases: Array<[ThinkLevel | undefined, string]> = [
    [undefined, "medium"],
    ["on", "medium"],
    ["high", "high"],
    ["off", "none"],
  ]
  for (const [think, effort] of cases) assert.deepEqual(openAIEffort(think), effort, think)
})

test("image response saves each image and counts tokens", () => {
  const saved: [number, number][] = []
  const response = processGptImageResponse(
    {
      created: 0,
      quality: "low",
      data: [{ b64_json: Buffer.from([1, 2, 3]).toString("base64") }],
      usage: {
        input_tokens: 20,
        input_tokens_details: { text_tokens: 20, image_tokens: 0 },
        output_tokens: 200,
        total_tokens: 220,
      },
    },
    testModel("openai", "image"),
    (bytes, i) => {
      saved.push([bytes.length, i])
      return `/images/${i}.png`
    },
  )
  assert.deepEqual(saved, [[3, 0]])
  assert.deepEqual(response.images, ["/images/0.png"])
  assert.deepEqual(response.content, "/images/0.png")
  assert.deepEqual(response.effort, "low")
  assert.deepEqual(response.tokens, { input: 20, output: 200 })
})

test("image generation rejects history and input images before requesting", () => {
  const user = { role: "user" as const, content: "a cat", createdAt: new Date() }
  const input: ChatInput = {
    chat: { id: "test", createdAt: new Date(), systemPrompt: "", messages: [user] },
    model: testModel("openai", "image"),
    apiKey: "test-key",
    config: { search: false, think: undefined },
  }
  assert.deepEqual(gptImageParams(input).prompt, "a cat")
  for (const messages of [
    [user, { ...user, content: "make it blue" }],
    [
      {
        ...user,
        image_urls: ["data:image/png;base64,AQID", "https://example.com/image.jpg"],
      },
    ],
    [],
  ]) {
    input.chat.messages = messages
    assert.throws(
      () => gptImageParams(input),
      errorIncluding(Error, "fresh text-only prompt"),
    )
  }
})

test("OpenAI structured response unwraps the value and keeps the response ID", async () => {
  const usage = {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 80 },
    output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 5 },
    total_tokens: 120,
  }
  const search = { type: "web_search_call", id: "ws", status: "completed" }
  const {
    result: response,
    bodies: [body],
  } = await recordRequests(
    () => openaiResponse(`{"value":"yes"}`, { id: "resp_1", usage, toolCalls: [search] }),
    () =>
      createMessage({
        chat: promptChat("Is it?"),
        model: testModel("openai"),
        apiKey: "test-key",
        config: { search: true, think: undefined },
        outputSchema: type("'yes' | 'no'"),
      }),
  )
  assert.deepEqual(body.text, {
    format: {
      type: "json_schema",
      name: "output",
      strict: true,
      schema: {
        type: "object",
        properties: { value: { enum: ["no", "yes"] } },
        required: ["value"],
        additionalProperties: false,
      },
    },
  })
  const { cost: _, ...rest } = response
  assert.deepEqual(rest, {
    content: "yes",
    tokens: { input: 100, output: 20, input_cache_hit: 80 },
    stop_reason: "completed",
    searches: 1,
    effort: "medium",
    provider: { type: "openai", responseId: "resp_1" },
  })
})
