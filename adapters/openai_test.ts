import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert"
import { encodeBase64 } from "@std/encoding/base64"

import { resolveModel } from "../models.ts"
import { gptImageParams, openAIEffort, processGptImageResponse } from "./openai.ts"
import type { ChatInput } from "./types.ts"

Deno.test("OpenAI reasoning intent resolves to native effort", () => {
  assertEquals(openAIEffort(undefined), "medium")
  assertEquals(openAIEffort("high"), "high")
  assertEquals(openAIEffort("off"), "none")
})

Deno.test("image response saves each image and prices usage", () => {
  const model = resolveModel("flare")
  const saved: [number, number][] = []
  const response = processGptImageResponse(
    {
      created: 0,
      quality: "low",
      data: [{ b64_json: encodeBase64(new Uint8Array([1, 2, 3])) }],
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
  assertEquals(saved, [[3, 0]])
  assertEquals(response.images, ["/images/0.png"])
  assertEquals(response.content, "/images/0.png")
  assertEquals(response.effort, "low")
  // (20 * 5 + 200 * 30) / 1_000_000
  assertAlmostEquals(response.cost, 0.0061)
})

Deno.test("image generation rejects history and input images before requesting", () => {
  const user = { role: "user" as const, content: "a cat", createdAt: new Date() }
  const input: ChatInput = {
    chat: { id: "test", createdAt: new Date(), systemPrompt: "", messages: [user] },
    model: resolveModel("flare"),
    config: { search: false, think: undefined },
  }
  assertEquals(gptImageParams(input).prompt, "a cat")
  for (
    const messages of [
      [user, { ...user, content: "make it blue" }],
      [{ ...user, image_url: "data:image/png;base64,AQID" }],
      [],
    ]
  ) {
    input.chat.messages = messages
    assertThrows(() => gptImageParams(input), Error, "fresh text-only prompt")
  }
})
