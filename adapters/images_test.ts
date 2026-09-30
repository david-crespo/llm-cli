import { assertEquals } from "@std/assert"

import { resolveModel } from "../models.ts"
import type { Chat } from "../types.ts"
import { createMessage } from "./mod.ts"

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
          { type: "input_image", image_url: firstImage, detail: "auto" },
          { type: "input_image", image_url: secondImage, detail: "auto" },
        ],
      },
      { role: "assistant", content: "ok" },
      {
        role: "user",
        content: [{ type: "input_image", image_url: imageUrl, detail: "auto" }],
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
