/**
 * Preload for running the CLI in tests (`node --import ./fake-fetch.ts`):
 * answers provider API requests with canned replies, appends each request's
 * URL and JSON body to the file in FAKE_FETCH_LOG, and throws on any other
 * request so nothing reaches the network. A request whose body includes
 * FAIL_REQUEST gets a 500.
 */
import { appendFileSync } from "node:fs"
import process from "node:process"

import { claudeStream, geminiResponse, openaiResponse } from "./testing.ts"

const log = process.env.FAKE_FETCH_LOG
if (!log) throw new Error("fake-fetch: FAKE_FETCH_LOG is not set")

let interactionCount = 0

const replies: Array<[RegExp, () => Response]> = [
  [
    /^https:\/\/api\.anthropic\.com\/v1\/messages\b/,
    () =>
      claudeStream([
        { type: "thinking", thinking: "Thinking it over.", signature: "sig" },
        { type: "text", text: "ok" },
      ]),
  ],
  [/^https:\/\/api\.openai\.com\/v1\/responses$/, () => openaiResponse()],
  [
    /^https:\/\/generativelanguage\.googleapis\.com\/v1\w*\/models\/[^/]+:generateContent$/,
    () => geminiResponse(),
  ],
  [
    /^https:\/\/generativelanguage\.googleapis\.com\/v1\w*\/interactions$/,
    () =>
      Response.json({
        id: `int_${++interactionCount}`,
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [{ type: "image", mime_type: "image/png", data: "AQID" }],
          },
        ],
      }),
  ],
]

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init)
  const reply = replies.find(([pattern]) => pattern.test(request.url))?.[1]
  if (!reply) throw new Error(`fake-fetch: unexpected request to ${request.url}`)
  const text = await request.text()
  appendFileSync(log, JSON.stringify({ url: request.url, body: JSON.parse(text) }) + "\n")
  if (text.includes("FAIL_REQUEST")) {
    // x-should-retry stops the Anthropic and OpenAI SDKs from retrying
    return Response.json(
      { error: { message: "Internal error" } },
      { status: 500, headers: { "x-should-retry": "false" } },
    )
  }
  return reply()
}
