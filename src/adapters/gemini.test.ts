import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { test } from "node:test"

import { ThinkingLevel } from "@google/genai"

import { type } from "arktype"

import { ValidationError } from "../errors.ts"
import {
  errorIncluding,
  geminiResponse,
  promptChat,
  recordRequests,
  testModel,
  withFetch,
} from "../testing.ts"
import { createMessage } from "./index.ts"
import { geminiThinkParams, processGeminiImageResponse, withCitations } from "./gemini.ts"

test("Gemini default sends MEDIUM, or MINIMAL on flash-lite", () => {
  assert.deepEqual(geminiThinkParams("gemini-4-neon", undefined), {
    thinkingLevel: ThinkingLevel.MEDIUM,
    effort: "medium",
  })
  assert.deepEqual(geminiThinkParams("gemini-3.5-flash-lite", undefined), {
    thinkingLevel: ThinkingLevel.MINIMAL,
    effort: "minimal",
  })
})

test("--quick only uses MINIMAL on flash-lite and Nano Banana", () => {
  assert.deepEqual(geminiThinkParams("gemini-3.7-flash", "off").effort, "low")
  assert.deepEqual(geminiThinkParams("gemini-3.1-pro-preview", "off").effort, "low")
  assert.deepEqual(geminiThinkParams("gemini-3.5-flash-lite", "off").effort, "minimal")
  assert.deepEqual(geminiThinkParams("gemini-nano-banana-2.1", "off").effort, "minimal")
  assert.deepEqual(geminiThinkParams("gemini-nano-banana-2.1", undefined).effort, "medium")
})

const chunk = (host: string, path = "") => ({
  web: { title: host, uri: `https://${host}/${path}` },
})

test("withCitations marks cited spans by byte offset into the joined answer", () => {
  const parts = [
    { text: "thinking", thought: true },
    // é is two bytes, so the first span ends at byte 13, not character 12
    { text: "Café opened. " },
    { text: "It closed." },
  ]
  const grounding = {
    groundingChunks: [
      chunk("a.com"),
      chunk("b.com", "1"),
      chunk("c.com"),
      chunk("b.com", "1"),
      chunk("uncited.com"),
    ],
    // Like real responses: no partIndex though the answer starts at part 1,
    // and two supports can end at the same byte offset
    groundingSupports: [
      { segment: { startIndex: 14, endIndex: 24 }, groundingChunkIndices: [2, 0] },
      { segment: { endIndex: 13 }, groundingChunkIndices: [3] },
      { segment: { startIndex: 17, endIndex: 24 }, groundingChunkIndices: [1, 2] },
    ],
  }
  assert.deepEqual(
    withCitations(parts, grounding),
    [
      "Café opened.[1] It closed.[1, 2, 3]",
      "",
      "### Sources",
      "",
      "1. [b.com](https://b.com/1)",
      "2. [c.com](https://c.com/)",
      "3. [a.com](https://a.com/)",
      "4. [uncited.com](https://uncited.com/)",
    ].join("\n"),
  )
})

test("withCitations places markers in a real grounded response", () => {
  const { candidates } = JSON.parse(
    readFileSync(
      new URL("../../test/fixtures/gemini-grounded-response.json", import.meta.url),
      "utf8",
    ),
  )
  const output = withCitations(candidates[0].content.parts, candidates[0].groundingMetadata)
  const [answer, sources] = output.split("\n\n### Sources\n\n")
  for (const cited of [
    "a member of its Board of Directors[1].",
    "reports of two extramarital affairs[2, 3].",
    "raising significant national security concerns[4, 5].",
    "a subordinate Nvidia executive[5].",
    "as its first-ever Chair of the Board[1, 6].",
    "below $4 trillion[4, 7].",
  ]) {
    assert(answer.includes(cited), cited)
  }
  assert.deepEqual(
    sources.split("\n").map((line) => line.replace(/\]\(.*/, "")),
    [
      "1. [nvidia.com",
      "2. [axios.com",
      "3. [washingtonpost.com",
      "4. [aljazeera.com",
      "5. [cbsnews.com",
      "6. [businessinsider.com",
      "7. [theguardian.com",
    ],
  )
})

test("withCitations lists every source when there are no supports", () => {
  const grounding = { groundingChunks: [chunk("a.com"), chunk("b.com")] }
  assert.deepEqual(
    withCitations([{ text: "Answer." }], grounding),
    "Answer.\n\n### Sources\n\n1. [a.com](https://a.com/)\n2. [b.com](https://b.com/)",
  )
  assert.deepEqual(withCitations([{ text: "Answer." }], undefined), "Answer.")
})

test("image response saves final images and counts image tokens separately", async () => {
  const saved: [string, string, number][] = []
  const response = await processGeminiImageResponse(
    {
      id: "int_1",
      status: "completed",
      steps: [
        {
          type: "thought",
          signature: "sig",
          summary: [{ type: "image", mime_type: "image/jpeg", data: "AAAA" }],
        },
        {
          type: "model_output",
          content: [
            { type: "text", text: "Here is your fox" },
            { type: "image", mime_type: "image/jpeg", data: "AQID" },
          ],
        },
      ],
      usage: {
        total_input_tokens: 10,
        total_output_tokens: 1411,
        total_thought_tokens: 596,
        output_tokens_by_modality: [{ modality: "image", tokens: 1120 }],
      },
    },
    testModel("google", "image"),
    async (bytes, mimeType, i) => {
      saved.push([Buffer.from(bytes).toString("base64"), mimeType, i])
      return `/images/${i}.png`
    },
  )
  assert.deepEqual(saved, [["AQID", "image/jpeg", 0]])
  assert.deepEqual(response.images, ["/images/0.png"])
  assert.deepEqual(response.content, "Here is your fox\n/images/0.png")
  assert.deepEqual(response.tokens, { input: 10, output: 2007, output_image: 1120 })
  assert.deepEqual(response.provider, { type: "google", interactionId: "int_1" })
})

test("image response without an image reports the model's text", async () => {
  await assert.rejects(
    processGeminiImageResponse(
      {
        id: "int_2",
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [{ type: "text", text: "I can't make that" }],
          },
        ],
      },
      testModel("google", "image"),
      async () => "",
    ),
    /No image in response \(completed\): I can't make that/,
  )
})

test("Gemini structured response skips citations and counts thinking as output", async () => {
  const parts = [{ text: "Checking", thought: true }, { text: '"yes"' }]
  const groundingMetadata = {
    groundingChunks: [chunk("a.com")],
    groundingSupports: [{ segment: { endIndex: 5 }, groundingChunkIndices: [0] }],
  }
  const usageMetadata = {
    promptTokenCount: 100,
    cachedContentTokenCount: 40,
    candidatesTokenCount: 10,
    thoughtsTokenCount: 30,
  }
  const {
    result: response,
    bodies: [body],
  } = await recordRequests(
    () => geminiResponse(parts, { groundingMetadata, usageMetadata }),
    () =>
      createMessage({
        chat: promptChat("Is it?"),
        model: testModel("google"),
        apiKey: "test-key",
        config: { search: true, think: undefined },
        outputSchema: type("'yes' | 'no'"),
      }),
  )
  assert.deepEqual(body.generationConfig, {
    responseMimeType: "application/json",
    responseJsonSchema: { enum: ["no", "yes"] },
    thinkingConfig: { includeThoughts: true, thinkingLevel: "MEDIUM" },
  })
  const { cost: _, ...rest } = response
  assert.deepEqual(rest, {
    content: "yes",
    reasoning: "Checking",
    tokens: { input: 100, output: 40, input_cache_hit: 40 },
    stop_reason: "STOP",
    searches: 1,
    effort: "medium",
  })
})

test("Gemini image editing sends inline input images with the prompt", async (t) => {
  const oldStateHome = process.env.XDG_STATE_HOME
  const stateHome = mkdtempSync(join(tmpdir(), "llm-gemini-img-"))
  process.env.XDG_STATE_HOME = stateHome
  t.after(() => {
    if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = oldStateHome
    rmSync(stateHome, { recursive: true })
  })

  const imageUrl = "https://example.com/ref.webp"
  let requestUrl: string | undefined
  let requestBody: Record<string, unknown> | undefined
  const mockFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    if (request.url === imageUrl) {
      return new Response(new Uint8Array([4, 5, 6]), {
        headers: { "content-type": "image/webp" },
      })
    }
    requestUrl = request.url
    requestBody = (await request.json()) as Record<string, unknown>
    return Response.json({
      id: "int_edit",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [{ type: "image", mime_type: "image/png", data: "AQID" }],
        },
      ],
    })
  }

  const chat = promptChat("Make it sunset")
  chat.messages[0] = {
    role: "user",
    content: "Make it sunset",
    createdAt: new Date(0),
    image_urls: ["data:image/png;base64,AQID", imageUrl],
  }

  const response = await withFetch(mockFetch, () =>
    createMessage({
      chat,
      model: testModel("google", "image"),
      apiKey: "test-key",
      config: { search: false, think: "off" },
      imageOptions: { size: "1K", aspect: "16:9" },
    }),
  )

  assert.match(requestUrl ?? "", /\/interactions$/)
  assert.deepEqual(requestBody?.input, [
    {
      type: "user_input",
      content: [
        { type: "image", mime_type: "image/png", data: "AQID" },
        { type: "image", mime_type: "image/webp", data: "BAUG" },
        { type: "text", text: "Make it sunset" },
      ],
    },
  ])
  assert.deepEqual(requestBody?.generation_config, { thinking_level: "minimal" })
  assert.deepEqual(requestBody?.response_format, {
    type: "image",
    image_size: "1K",
    aspect_ratio: "16:9",
  })
  assert.deepEqual(response.effort, "minimal")
  assert.deepEqual(response.provider, { type: "google", interactionId: "int_edit" })
  assert.deepEqual(response.images?.length, 1)
  assert.deepEqual(readFileSync(response.images![0]), Buffer.from([1, 2, 3]))
})

test("Gemini image editing rejects oversized requests before sending", async () => {
  let apiCalls = 0
  await withFetch(
    () => {
      apiCalls++
      return Promise.resolve(geminiResponse())
    },
    () =>
      assert.rejects(
        () =>
          createMessage({
            model: testModel("google", "image"),
            apiKey: "test-key",
            config: { search: false, think: undefined },
            chat: {
              id: "test",
              createdAt: new Date(0),
              systemPrompt: "test",
              messages: [
                {
                  role: "user",
                  content: "Edit this",
                  image_urls: ["data:image/png;base64," + "A".repeat(20_000_000)],
                  createdAt: new Date(0),
                },
              ],
            },
          }),
        errorIncluding(ValidationError, "Gemini request is larger than the 20 MB limit"),
      ),
  )
  assert.deepEqual(apiCalls, 0)
})

test("Gemini image replies chain previous_interaction_id and fall back to saved PNG on 404 or cross-model", async (t) => {
  const oldStateHome = process.env.XDG_STATE_HOME
  const stateHome = mkdtempSync(join(tmpdir(), "llm-gemini-reply-"))
  process.env.XDG_STATE_HOME = stateHome
  t.after(() => {
    if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = oldStateHome
    rmSync(stateHome, { recursive: true })
  })

  const prevPath = join(stateHome, "prev.png")
  writeFileSync(prevPath, new Uint8Array([9, 8, 7]))
  const model = testModel("google", "image")

  const okInteraction = (id: string) =>
    Response.json({
      id,
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [{ type: "image", mime_type: "image/png", data: "AQID" }],
        },
      ],
    })

  const makeChat = (provider?: { type: "google"; interactionId: string }) => ({
    id: "test",
    createdAt: new Date(0),
    systemPrompt: "",
    messages: [
      { role: "user" as const, content: "a fox", createdAt: new Date(0) },
      {
        role: "assistant" as const,
        model: provider ? model.id : testModel("openai", "image").id,
        content: prevPath,
        images: [prevPath],
        provider,
        tokens: { input: 10, output: 100 },
        stop_reason: "completed",
        cost: 0,
        timeMs: 100,
        createdAt: new Date(0),
      },
      { role: "user" as const, content: "make it blue", createdAt: new Date(0) },
    ],
  })

  // 1. Direct Gemini reply chains previous_interaction_id without re-sending the image
  const { bodies: chainedBodies, result: chained } = await recordRequests(
    () => okInteraction("int_2"),
    () =>
      createMessage({
        chat: makeChat({ type: "google", interactionId: "int_1" }),
        model,
        apiKey: "test-key",
        config: { search: false, think: undefined },
      }),
  )
  assert.deepEqual(chainedBodies.length, 1)
  assert.deepEqual(chainedBodies[0].previous_interaction_id, "int_1")
  assert.deepEqual(chainedBodies[0].input, "make it blue")
  assert.deepEqual(chained.provider, { type: "google", interactionId: "int_2" })

  // 2. Expired interaction (404) retries once with the saved PNG and no previous_interaction_id
  const retryBodies: Record<string, unknown>[] = []
  await withFetch(
    async (input, init) => {
      retryBodies.push((await new Request(input, init).json()) as Record<string, unknown>)
      if (retryBodies.length === 1) {
        return Response.json(
          { error: { code: 404, message: "Interaction not found" } },
          { status: 404 },
        )
      }
      return okInteraction("int_3")
    },
    () =>
      createMessage({
        chat: makeChat({ type: "google", interactionId: "int_expired" }),
        model,
        apiKey: "test-key",
        config: { search: false, think: undefined },
      }),
  )
  assert.deepEqual(retryBodies.length, 2)
  assert.deepEqual(retryBodies[0].previous_interaction_id, "int_expired")
  assert.deepEqual(retryBodies[1].previous_interaction_id, undefined)
  assert.deepEqual(retryBodies[1].input, [
    {
      type: "user_input",
      content: [
        {
          type: "image",
          mime_type: "image/png",
          data: Buffer.from([9, 8, 7]).toString("base64"),
        },
        { type: "text", text: "make it blue" },
      ],
    },
  ])

  // 3. Cross-model reply (previous turn from OpenAI, no interactionId) edits the saved PNG directly
  const { bodies: crossBodies } = await recordRequests(
    () => okInteraction("int_4"),
    () =>
      createMessage({
        chat: makeChat(undefined),
        model,
        apiKey: "test-key",
        config: { search: false, think: undefined },
      }),
  )
  assert.deepEqual(crossBodies.length, 1)
  assert.deepEqual(crossBodies[0].previous_interaction_id, undefined)
  assert.deepEqual(crossBodies[0].input, [
    {
      type: "user_input",
      content: [
        {
          type: "image",
          mime_type: "image/png",
          data: Buffer.from([9, 8, 7]).toString("base64"),
        },
        { type: "text", text: "make it blue" },
      ],
    },
  ])
})
