import { assertEquals, assertRejects } from "@std/assert"
import { ValidationError } from "@cliffy/command"
import { type } from "arktype"

import { resolveModel } from "../models.ts"
import type { Chat } from "../types.ts"
import { createMessage, gptBg } from "./mod.ts"
import { validateClaudeImageSize } from "./request_size.ts"

const firstImage = "data:image/png;base64,AQID"
const secondImage = "data:image/jpeg;base64,BAUG"
const imageUrl = "https://example.com/third.webp"

const cases = [
  {
    model: "sonnet",
    env: "ANTHROPIC_API_KEY",
    response: {
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: "end_turn",
    },
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
    model: "gpt-6.1-sol",
    env: "OPENAI_API_KEY",
    response: { id: "response", output: [], status: "completed" },
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
    model: "gemini-3.8-flash",
    env: "GEMINI_API_KEY",
    response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] },
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
  Deno.test(`${testCase.env} sends all images in order, including history and image-only turns`, async () => {
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
          model: testCase.model,
          createdAt: new Date(0),
          tokens: { input: 0, output: 0 },
          stop_reason: "stop",
          cost: 0,
          timeMs: 0,
        },
        { role: "user", content: "", createdAt: new Date(0), image_urls: [imageUrl] },
      ],
    }
    const oldKey = Deno.env.get(testCase.env)
    const originalFetch = globalThis.fetch
    let requestBody: Record<string, unknown> | undefined
    Deno.env.set(testCase.env, "test-key")
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      if (request.url === imageUrl) {
        return new Response(new Uint8Array([7, 8, 9]), {
          headers: { "content-type": "image/webp; charset=binary" },
        })
      }
      requestBody = await request.json()
      return Response.json(testCase.response)
    }
    try {
      await createMessage({
        chat,
        model: resolveModel(testCase.model),
        config: { search: false, think: undefined },
      })
      assertEquals(
        requestBody?.messages ?? requestBody?.input ?? requestBody?.contents,
        testCase.messages,
      )
    } finally {
      globalThis.fetch = originalFetch
      if (oldKey === undefined) Deno.env.delete(testCase.env)
      else Deno.env.set(testCase.env, oldKey)
    }
  })
}

Deno.test("Claude's per-image base64 limit accepts the boundary", () => {
  validateClaudeImageSize("A".repeat(10_000_000))
})

Deno.test("Gemini size validation matches the SDK's wire body including schema and tools", async () => {
  const originalFetch = globalThis.fetch
  const oldKey = Deno.env.get("GEMINI_API_KEY")
  const wireSizes: number[] = []
  Deno.env.set("GEMINI_API_KEY", "test-key")
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    wireSizes.push((await request.arrayBuffer()).byteLength)
    return Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })
  }
  const message = {
    role: "user" as const,
    content: "x",
    image_urls: [firstImage],
    createdAt: new Date(0),
  }
  const input = {
    model: resolveModel("gemini-3.8-flash"),
    config: { search: true, think: "high" as const },
    outputSchema: type({ answer: "string" }),
    chat: {
      id: "test",
      createdAt: new Date(0),
      systemPrompt: 'Read 猫 and preserve "quotes"\nand newlines',
      messages: [message],
    },
  }
  try {
    await createMessage(input)
    message.content = "x".repeat(20_000_000 - wireSizes[0] + 1)
    await createMessage(input)
    assertEquals(wireSizes[1], 20_000_000)
    message.content += "x"
    await assertRejects(
      () => createMessage(input),
      ValidationError,
      "Gemini request is larger than the 20 MB limit",
    )
    assertEquals(wireSizes.length, 2)
  } finally {
    globalThis.fetch = originalFetch
    if (oldKey === undefined) Deno.env.delete("GEMINI_API_KEY")
    else Deno.env.set("GEMINI_API_KEY", oldKey)
  }
})

Deno.test("OpenAI background requests use high image detail and send only the chained turn", async () => {
  const originalFetch = globalThis.fetch
  const oldKey = Deno.env.get("OPENAI_API_KEY")
  let requestBody: Record<string, unknown> | undefined
  Deno.env.set("OPENAI_API_KEY", "test-key")
  globalThis.fetch = async (input, init) => {
    requestBody = await new Request(input, init).json()
    return Response.json({ id: "new-response", output: [], status: "queued" })
  }
  try {
    await gptBg.initiate({
      model: resolveModel("gpt-6.1-sol"),
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
            model: "gpt-6.1-sol",
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
    assertEquals(requestBody?.input, [{
      role: "user",
      content: [
        { type: "input_image", image_url: secondImage, detail: "high" },
        { type: "input_image", image_url: imageUrl, detail: "high" },
      ],
    }])
    assertEquals(requestBody?.previous_response_id, "previous-response")
    assertEquals(requestBody?.background, true)
    assertEquals(requestBody?.store, true)
  } finally {
    globalThis.fetch = originalFetch
    if (oldKey === undefined) Deno.env.delete("OPENAI_API_KEY")
    else Deno.env.set("OPENAI_API_KEY", oldKey)
  }
})

for (
  const testCase of [
    {
      model: "sonnet",
      env: "ANTHROPIC_API_KEY",
      images: ["data:image/png;base64," + "A".repeat(10_000_004)],
      prompt: "Describe this",
      error: "Claude image is larger than the 10 MB base64 limit",
    },
    {
      model: "sonnet",
      env: "ANTHROPIC_API_KEY",
      images: Array.from(
        { length: 4 },
        () => "data:image/png;base64," + "A".repeat(8_000_000),
      ),
      prompt: "Compare these",
      error: "Claude request is larger than the 32 MB limit",
    },
    {
      model: "gemini-3.8-flash",
      env: "GEMINI_API_KEY",
      images: ["data:image/png;base64," + "A".repeat(19_999_000)],
      // UTF-8 text and JSON overhead push an otherwise in-limit image over the limit.
      prompt: "猫".repeat(400),
      error: "Gemini request is larger than the 20 MB limit",
    },
    {
      model: "gemini-3.8-flash",
      env: "GEMINI_API_KEY",
      images: [imageUrl],
      prompt: "Describe this",
      error: "Gemini request is larger than the 20 MB limit",
    },
  ]
) {
  Deno.test(`${testCase.model} rejects oversized encoded images and requests before sending: ${testCase.error}`, async () => {
    const originalFetch = globalThis.fetch
    const oldKey = Deno.env.get(testCase.env)
    let apiCalls = 0
    Deno.env.set(testCase.env, "test-key")
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
      const response = cases.find((c) => c.model === testCase.model)!.response
      return Promise.resolve(Response.json(response))
    }
    try {
      await assertRejects(
        () =>
          createMessage({
            model: resolveModel(testCase.model),
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
        ValidationError,
        testCase.error,
      )
      assertEquals(apiCalls, 0)
    } finally {
      globalThis.fetch = originalFetch
      if (oldKey === undefined) Deno.env.delete(testCase.env)
      else Deno.env.set(testCase.env, oldKey)
    }
  })
}
