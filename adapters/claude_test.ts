import assert from "node:assert/strict"
import { test } from "node:test"

import { claudeStream, promptChat, testModel, withFetch } from "../testing.ts"
import type { ThinkLevel } from "../types.ts"
import { claudeThinkParams } from "./claude.ts"
import { createMessage } from "./mod.ts"

test("Claude thinks adaptively at an effort for each level", () => {
  const cases: Array<[ThinkLevel | undefined, string]> = [
    [undefined, "medium"],
    ["on", "high"],
    ["high", "xhigh"],
    ["off", "low"],
  ]
  for (const [think, effort] of cases) {
    assert.deepEqual(claudeThinkParams(think), {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort },
      effort,
    })
  }
})

const cite = (url: string, title: string | null) => ({
  type: "web_search_result_location",
  url,
  title,
  cited_text: "...",
  encrypted_index: "x",
})

test("Claude response joins blocks, cites sources, and counts cached tokens", async () => {
  const content = [
    { type: "thinking", thinking: "Look it up.", signature: "sig" },
    { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "fox diet" } },
    { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
    {
      type: "server_tool_use",
      id: "f1",
      name: "web_fetch",
      input: { url: "https://a.com" },
    },
    {
      type: "text",
      text: "Foxes eat berries",
      citations: [
        cite("https://a.com", "A"),
        cite("https://a.com", "A"),
        cite("https://b.com", null),
      ],
    },
    { type: "text", text: "and mice", citations: [cite("https://c.com", "C")] },
    { type: "text", text: "." },
  ]
  const usage = {
    input_tokens: 10,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 200,
    output_tokens: 50,
    server_tool_use: { web_search_requests: 2 },
  }
  const response = await withFetch(
    async () => claudeStream(content, usage),
    () =>
      createMessage({
        chat: promptChat("What do foxes eat?"),
        model: testModel("anthropic"),
        apiKey: "test-key",
        config: { search: true, think: undefined },
      }),
  )
  const { cost: _, ...rest } = response
  assert.deepEqual(rest, {
    content: [
      "**Search:** fox diet",
      "**Fetch:** https://a.com",
      "Foxes eat berries ([A](https://a.com) · [https://b.com](https://b.com))" +
        " and mice ([C](https://c.com)).",
    ].join("\n\n"),
    reasoning: "Look it up.",
    // input_tokens counts only cache misses
    tokens: { input: 1210, output: 50, input_cache_hit: 1000, input_cache_write: 200 },
    stop_reason: "end_turn",
    searches: 2,
    effort: "medium",
  })
})
