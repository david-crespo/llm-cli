import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { test } from "node:test"
import { type } from "arktype"

import { ValidationError } from "../errors.ts"
import {
  errorIncluding,
  openaiResponse,
  promptChat,
  recordRequests,
  testModel,
  withFetch,
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

test("image generation rejects text-only history and empty text before requesting", () => {
  const user = { role: "user" as const, content: "a cat", createdAt: new Date() }
  const input: ChatInput = {
    chat: { id: "test", createdAt: new Date(), systemPrompt: "", messages: [user] },
    model: testModel("openai", "image"),
    apiKey: "test-key",
    config: { search: false, think: undefined },
  }
  assert.deepEqual(gptImageParams(input).prompt, "a cat")
  input.chat.messages = [{ ...user, image_urls: ["data:image/png;base64,AQID"] }]
  assert.deepEqual(gptImageParams(input).prompt, "a cat")

  for (const messages of [
    [{ ...user, content: "", image_urls: ["data:image/png;base64,AQID"] }],
    [{ ...user, content: "   " }],
    [],
  ]) {
    input.chat.messages = messages
    assert.throws(
      () => gptImageParams(input),
      errorIncluding(ValidationError, "prompt with text"),
    )
  }

  input.chat.messages = [user, { ...user, content: "make it blue" }]
  assert.throws(
    () => gptImageParams(input),
    errorIncluding(ValidationError, "no previous image"),
  )
})

test("OpenAI image reply prepends the previous generated image before new -i images", async (t) => {
  const oldStateHome = process.env.XDG_STATE_HOME
  const stateHome = mkdtempSync(join(tmpdir(), "llm-openai-reply-"))
  process.env.XDG_STATE_HOME = stateHome
  t.after(() => {
    if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = oldStateHome
    rmSync(stateHome, { recursive: true })
  })

  const prevPath = join(stateHome, "prev.png")
  writeFileSync(prevPath, new Uint8Array([9, 8, 7]))

  const calls: Array<{ url: string; form: FormData }> = []
  const mockFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    if (request.url === "data:,") return new Response()
    calls.push({ url: request.url, form: await request.formData() })
    return Response.json({
      created: 0,
      quality: "auto",
      data: [{ b64_json: Buffer.from([1, 2, 3]).toString("base64") }],
    })
  }

  const model = testModel("openai", "image")
  await withFetch(mockFetch, () =>
    createMessage({
      model,
      apiKey: "test-key",
      config: { search: false, think: undefined },
      chat: {
        id: "test",
        createdAt: new Date(0),
        systemPrompt: "",
        messages: [
          { role: "user", content: "a cat", createdAt: new Date(0) },
          {
            role: "assistant",
            model: model.id,
            content: prevPath,
            images: [prevPath],
            tokens: { input: 10, output: 100 },
            stop_reason: "completed",
            cost: 0,
            timeMs: 100,
            createdAt: new Date(0),
          },
          {
            role: "user",
            content: "give it this hat",
            image_urls: ["data:image/jpeg;base64,AQID"],
            createdAt: new Date(0),
          },
        ],
      },
    }),
  )

  assert.deepEqual(calls[0].url, "https://api.openai.com/v1/images/edits")
  assert.deepEqual(calls[0].form.get("prompt"), "give it this hat")
  const files = calls[0].form.getAll("image[]") as File[]
  assert.deepEqual(
    files.map((f) => [f.name, f.type]),
    [
      ["image-0.png", "image/png"],
      ["image-1.jpg", "image/jpeg"],
    ],
  )
  assert.deepEqual(new Uint8Array(await files[0].arrayBuffer()), new Uint8Array([9, 8, 7]))
  assert.deepEqual(new Uint8Array(await files[1].arrayBuffer()), new Uint8Array([1, 2, 3]))
})

test("OpenAI image editing sends multipart images to /images/edits", async (t) => {
  const oldStateHome = process.env.XDG_STATE_HOME
  const stateHome = mkdtempSync(join(tmpdir(), "llm-openai-img-"))
  process.env.XDG_STATE_HOME = stateHome
  t.after(() => {
    if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = oldStateHome
    rmSync(stateHome, { recursive: true })
  })

  const remoteUrl = "https://example.com/second.webp"
  const calls: Array<{ url: string; form: FormData }> = []
  const mockFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    if (request.url === "data:,") return new Response()
    if (request.url === remoteUrl) {
      return new Response(new Uint8Array([4, 5, 6]), {
        headers: { "content-type": "image/webp; charset=binary" },
      })
    }
    calls.push({ url: request.url, form: await request.formData() })
    return Response.json({
      created: 0,
      quality: "high",
      data: [{ b64_json: Buffer.from([7, 8, 9]).toString("base64") }],
      usage: {
        input_tokens: 100,
        input_tokens_details: { text_tokens: 20, image_tokens: 80 },
        output_tokens: 200,
        total_tokens: 300,
      },
    })
  }

  const model = testModel("openai", "image")
  const run = (image_urls: string[]) =>
    withFetch(mockFetch, () =>
      createMessage({
        model,
        apiKey: "test-key",
        config: { search: false, think: undefined },
        imageOptions: { quality: "high", size: "1024x1024" },
        chat: {
          id: "test",
          createdAt: new Date(0),
          systemPrompt: "",
          messages: [
            { role: "user", content: "Add a hat", image_urls, createdAt: new Date(0) },
          ],
        },
      }),
    )

  // Single image sends `image`
  const single = await run(["data:image/png;base64,AQID"])
  assert.deepEqual(calls[0].url, "https://api.openai.com/v1/images/edits")
  assert.deepEqual(calls[0].form.get("model"), model.key)
  assert.deepEqual(calls[0].form.get("prompt"), "Add a hat")
  assert.deepEqual(calls[0].form.get("quality"), "high")
  assert.deepEqual(calls[0].form.get("size"), "1024x1024")
  assert.deepEqual(calls[0].form.get("output_format"), "png")
  const file0 = calls[0].form.get("image") as File
  assert.deepEqual([file0.name, file0.type], ["image-0.png", "image/png"])
  assert.deepEqual(new Uint8Array(await file0.arrayBuffer()), new Uint8Array([1, 2, 3]))
  assert.deepEqual(readFileSync(single.images![0]), Buffer.from([7, 8, 9]))

  // Multiple images send `image[]` in order
  await run(["data:image/jpeg;base64,AQID", remoteUrl])
  assert.deepEqual(calls[1].url, "https://api.openai.com/v1/images/edits")
  const files = calls[1].form.getAll("image[]") as File[]
  assert.deepEqual(
    files.map((f) => [f.name, f.type]),
    [
      ["image-0.jpg", "image/jpeg"],
      ["image-1.webp", "image/webp"],
    ],
  )
  assert.deepEqual(new Uint8Array(await files[1].arrayBuffer()), new Uint8Array([4, 5, 6]))
})

test("OpenAI image editing rejects GIFs and >16 images before uploading", async () => {
  let apiCalls = 0
  const mockFetch: typeof fetch = () => {
    apiCalls++
    return Promise.resolve(Response.json({ created: 0, data: [] }))
  }
  const makeInput = (image_urls: string[]): ChatInput => ({
    model: testModel("openai", "image"),
    apiKey: "test-key",
    config: { search: false, think: undefined },
    chat: {
      id: "test",
      createdAt: new Date(0),
      systemPrompt: "",
      messages: [{ role: "user", content: "Edit", image_urls, createdAt: new Date(0) }],
    },
  })

  await withFetch(mockFetch, async () => {
    await assert.rejects(
      () => createMessage(makeInput(["data:image/gif;base64,AQID"])),
      errorIncluding(ValidationError, "only supports PNG, JPEG, and WebP"),
    )
    await assert.rejects(
      () =>
        createMessage(
          makeInput(Array.from({ length: 17 }, () => "data:image/png;base64,AQID")),
        ),
      errorIncluding(ValidationError, "at most 16 images"),
    )
  })
  assert.deepEqual(apiCalls, 0)
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
