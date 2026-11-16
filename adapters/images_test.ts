import assert from "node:assert/strict"
import { test } from "node:test"
import { errorIncluding, testModel } from "../testing.ts"
import { ValidationError } from "../errors.ts"

import type { Chat } from "../types.ts"
import { createMessage, gptBg } from "./mod.ts"
import { validateClaudeImageSize } from "./request_size.ts"

const firstImage = "data:image/png;base64,AQID"
const secondImage = "data:image/jpeg;base64,BAUG"
const imageUrl = "https://example.com/third.webp"

// Claude requests stream, so the mock answers with server-sent events
const claudeStream = (text: string) =>
  new Response(
    [
      {
        type: "message_start",
        message: { content: [], usage: { input_tokens: 0, output_tokens: 0 } },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 0 },
      },
      { type: "message_stop" },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )

const cases = [
  {
    provider: "anthropic",
    respond: () => claudeStream("ok"),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AQID" },
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: "BAUG" },
          },
          { type: "text", text: "Compare these" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        content: [{ type: "image", source: { type: "url", url: imageUrl } }],
      },
    ],
  },
  {
    provider: "openai",
    respond: () => Response.json({ id: "response", output: [], status: "completed" }),
    messages: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Compare these" },
          { type: "input_image", image_url: firstImage, detail: "high" },
          { type: "input_image", image_url: secondImage, detail: "high" },
        ],
      },
      { role: "assistant", content: "ok" },
      {
        role: "user",
        content: [{ type: "input_image", image_url: imageUrl, detail: "high" }],
      },
    ],
  },
  {
    provider: "google",
    respond: () =>
      Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
    messages: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/png", data: "AQID" } },
          { inlineData: { mimeType: "image/jpeg", data: "BAUG" } },
          { text: "Compare these" },
        ],
      },
      { role: "model", parts: [{ text: "ok" }] },
      { role: "user", parts: [{ inlineData: { mimeType: "image/webp", data: "BwgJ" } }] },
    ],
  },
]

for (const testCase of cases) {
  test(`${testCase.provider} sends all images in order, including history and image-only turns`, async () => {
    const model = testModel(testCase.provider)
    const chat: Chat = {
      id: "test",
      createdAt: new Date(0),
      systemPrompt: "test",
      messages: [
        {
          role: "user",
          content: "Compare these",
          createdAt: new Date(0),
          image_urls: [firstImage, secondImage],
        },
        {
          role: "assistant",
          content: "ok",
          model: model.id,
          createdAt: new Date(0),
          tokens: { input: 0, output: 0 },
          stop_reason: "stop",
          cost: 0,
          timeMs: 0,
        },
        { role: "user", content: "", createdAt: new Date(0), image_urls: [imageUrl] },
      ],
    }
    const originalFetch = globalThis.fetch
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      if (request.url === imageUrl) {
        return new Response(new Uint8Array([7, 8, 9]), {
          headers: { "content-type": "image/webp; charset=binary" },
        })
      }
      requestBody = (await request.json()) as Record<string, unknown>
      return testCase.respond()
    }
    try {
      await createMessage({
        chat,
        model,
        apiKey: "test-key",
        config: { search: false, think: undefined },
      })
      assert.deepEqual(
        requestBody?.messages ?? requestBody?.input ?? requestBody?.contents,
        testCase.messages,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
}

test("Claude's per-image base64 limit accepts the boundary", () => {
  validateClaudeImageSize("A".repeat(10_000_000))
})

test("OpenAI background requests use high image detail and send only the chained turn", async () => {
  const originalFetch = globalThis.fetch
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = async (input, init) => {
    requestBody = (await new Request(input, init).json()) as Record<string, unknown>
    return Response.json({ id: "new-response", output: [], status: "queued" })
  }
  try {
    await gptBg.initiate({
      model: testModel("openai"),
      apiKey: "test-key",
      config: { search: false, think: undefined },
      chat: {
        id: "test",
        createdAt: new Date(0),
        systemPrompt: "test",
        messages: [
          {
            role: "user",
            content: "Earlier image",
            image_urls: [firstImage],
            createdAt: new Date(0),
          },
          {
            role: "assistant",
            content: "ok",
            model: testModel("openai").id,
            provider: { type: "openai", responseId: "previous-response" },
            createdAt: new Date(0),
            tokens: { input: 0, output: 0 },
            stop_reason: "stop",
            cost: 0,
            timeMs: 0,
          },
          {
            role: "user",
            content: "",
            image_urls: [secondImage, imageUrl],
            createdAt: new Date(0),
          },
        ],
      },
    })
    assert.deepEqual(requestBody?.input, [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: secondImage, detail: "high" },
          { type: "input_image", image_url: imageUrl, detail: "high" },
        ],
      },
    ])
    assert.deepEqual(requestBody?.previous_response_id, "previous-response")
    assert.deepEqual(requestBody?.background, true)
    assert.deepEqual(requestBody?.store, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

for (const testCase of [
  {
    provider: "anthropic",
    images: ["data:image/png;base64," + "A".repeat(10_000_004)],
    prompt: "Describe this",
    error: "Claude image is larger than the 10 MB base64 limit",
  },
  {
    provider: "anthropic",
    images: Array.from(
      { length: 4 },
      () => "data:image/png;base64," + "A".repeat(8_000_000),
    ),
    prompt: "Compare these",
    error: "Claude request is larger than the 32 MB limit",
  },
  {
    provider: "google",
    images: ["data:image/png;base64," + "A".repeat(19_999_000)],
    // UTF-8 text and JSON overhead push an otherwise in-limit image over the limit.
    prompt: "猫".repeat(400),
    error: "Gemini request is larger than the 20 MB limit",
  },
  {
    provider: "google",
    images: [imageUrl],
    prompt: "Describe this",
    error: "Gemini request is larger than the 20 MB limit",
  },
]) {
  test(`${testCase.provider} rejects oversized encoded images and requests before sending: ${testCase.error}`, async () => {
    const originalFetch = globalThis.fetch
    let apiCalls = 0
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init)
      if (request.url === imageUrl) {
        return Promise.resolve(
          new Response(new Uint8Array(15_000_000), {
            headers: { "content-type": "image/webp" },
          }),
        )
      }
      apiCalls++
      return Promise.resolve(cases.find((c) => c.provider === testCase.provider)!.respond())
    }
    try {
      await assert.rejects(
        () =>
          createMessage({
            model: testModel(testCase.provider),
            apiKey: "test-key",
            config: { search: false, think: undefined },
            chat: {
              id: "test",
              createdAt: new Date(0),
              systemPrompt: "test",
              messages: [
                {
                  role: "user",
                  content: testCase.prompt,
                  image_urls: testCase.images,
                  createdAt: new Date(0),
                },
                { role: "user", content: "Follow up", createdAt: new Date(0) },
              ],
            },
          }),
        errorIncluding(ValidationError, testCase.error),
      )
      assert.deepEqual(apiCalls, 0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
}
