import assert from "node:assert/strict"
import { test } from "node:test"
import { assertAlmostEqual, errorIncluding } from "../testing.ts"
import { Buffer } from "node:buffer"

import { resolveModel } from "../models.ts"
import { gptImageParams, openAIEffort, processGptImageResponse } from "./openai.ts"
import type { ChatInput } from "./types.ts"

test("OpenAI reasoning intent resolves to native effort", () => {
  assert.deepEqual(openAIEffort(undefined), "medium")
  assert.deepEqual(openAIEffort("high"), "high")
  assert.deepEqual(openAIEffort("off"), "none")
})

test("image response saves each image and prices usage", () => {
  const model = resolveModel("flare")
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
    model,
    (bytes, i) => {
      saved.push([bytes.length, i])
      return `/images/${i}.png`
    },
  )
  assert.deepEqual(saved, [[3, 0]])
  assert.deepEqual(response.images, ["/images/0.png"])
  assert.deepEqual(response.content, "/images/0.png")
  assert.deepEqual(response.effort, "low")
  // (20 * 5 + 200 * 30) / 1_000_000
  assertAlmostEqual(response.cost, 0.0061)
})

test("image generation rejects history and input images before requesting", () => {
  const user = { role: "user" as const, content: "a cat", createdAt: new Date() }
  const input: ChatInput = {
    chat: { id: "test", createdAt: new Date(), systemPrompt: "", messages: [user] },
    model: resolveModel("flare"),
    config: { search: false, think: undefined },
  }
  assert.deepEqual(gptImageParams(input).prompt, "a cat")
  for (
    const messages of [
      [user, { ...user, content: "make it blue" }],
      [{
        ...user,
        image_urls: ["data:image/png;base64,AQID", "https://example.com/image.jpg"],
      }],
      [],
    ]
  ) {
    input.chat.messages = messages
    assert.throws(
      () => gptImageParams(input),
      errorIncluding(Error, "fresh text-only prompt"),
    )
  }
})
