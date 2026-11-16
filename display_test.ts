import assert from "node:assert/strict"
import { test } from "node:test"
import {
  chatToMd,
  formatElapsed,
  longDateFmt,
  messageContentMd,
  metaLineMd,
} from "./display.ts"
import { systemBase } from "./models.ts"
import type { Chat, ChatMessage } from "./types.ts"

const assistantMessage = (
  effort?: string,
): Extract<ChatMessage, { role: "assistant" }> => ({
  role: "assistant",
  model: "gpt-5.6-sol",
  createdAt: new Date(0),
  content: "hi",
  tokens: { input: 1, output: 2 },
  stop_reason: "completed",
  cost: 0,
  timeMs: 1000,
  effort,
})

test("messageContentMd lists every attached image in order", () => {
  const msg: ChatMessage = {
    role: "user",
    content: "Compare these",
    createdAt: new Date(0),
    image_urls: ["data:image/png;base64,AQID", "https://example.com/second.jpg"],
  }
  assert.deepEqual(
    messageContentMd(msg, "cli"),
    "Compare these\n\n[Image 1 (inline)]\n\n[Image 2](https://example.com/second.jpg)\n\n",
  )
})

test("formatElapsed", () => {
  const cases: Array<[number, string]> = [
    [0, "0s"],
    [5000, "5s"],
    [2750, "2.75s"],
    [65000, "1m5s"],
    // seconds are truncated once there are minutes
    [90500, "1m30s"],
  ]
  for (const [ms, expected] of cases) assert.deepEqual(formatElapsed(ms), expected)
})

test("metaLineMd abbreviates known reasoning efforts", () => {
  assert.deepEqual(
    metaLineMd(assistantMessage("minimal")),
    "`gpt-5.6-sol` (min) | 1s | $0 | 1 -> 2",
  )
  assert.deepEqual(
    metaLineMd(assistantMessage("medium")),
    "`gpt-5.6-sol` (med) | 1s | $0 | 1 -> 2",
  )
})

test("metaLineMd passes through unknown efforts and preserves legacy output", () => {
  assert.deepEqual(
    metaLineMd(assistantMessage("future")),
    "`gpt-5.6-sol` (future) | 1s | $0 | 1 -> 2",
  )
  assert.deepEqual(metaLineMd(assistantMessage()), "`gpt-5.6-sol` | 1s | $0 | 1 -> 2")
})

test("chatToMd ignores date differences in the default system prompt", () => {
  // Simulate a chat created on a previous day: same default prompt but with a
  // stale date baked in. It should still be treated as the default prompt.
  const stalePrompt = systemBase.replace(
    /Today's date is \d{4}-\d{2}-\d{2}/,
    "Today's date is 2020-01-01",
  )
  const chat: Chat = {
    id: "test",
    systemPrompt: stalePrompt,
    messages: [assistantMessage()],
    createdAt: new Date(0),
  }
  const started = `**Chat started:** ${longDateFmt.format(chat.createdAt)}\n\n`
  const body = "# assistant (1/1)\n\n`gpt-5.6-sol` | 1s | $0 | 1 -> 2\n\nhi\n\n"
  assert.deepEqual(chatToMd({ chat }), started + body)

  // A customized prompt is still reported.
  const systemPrompt = stalePrompt + "\n- extra"
  assert.deepEqual(
    chatToMd({ chat: { ...chat, systemPrompt } }),
    `${started}**System prompt:** ${systemPrompt}\n\n${body}`,
  )
})

test("generated image paths become Markdown images except in raw and gist", () => {
  const path = "/images/fox.png"
  const msg = { ...assistantMessage(), content: `Here you go\n${path}`, images: [path] }
  assert(messageContentMd(msg, "cli").includes(`Here you go\n![](<${path}>)`))
  assert.deepEqual(messageContentMd(msg, "raw"), `Here you go\n${path}`)
  assert(messageContentMd(msg, "gist").includes(`Here you go\n${path}`))
})

test("chatToMd selects messages and collapses reasoning and long input in gists", () => {
  const long = Array.from({ length: 41 }, (_, i) => `line ${i + 1}`).join("\n")
  const pasted = `<details>\n${long}\n</details>`
  const chat: Chat = {
    id: "test",
    createdAt: new Date(0),
    systemPrompt: "Be brief.",
    messages: [
      { role: "user", content: long, createdAt: new Date(0) },
      {
        ...assistantMessage("high"),
        content: "Answer",
        reasoning: "First\nSecond",
        tokens: { input: 100, input_cache_hit: 80, output: 20 },
        searches: 3,
        stop_reason: "max_tokens",
      },
      { role: "user", content: pasted, createdAt: new Date(0) },
      { ...assistantMessage(), content: "Done", searches: 1 },
    ],
  }
  const started = `**Chat started:** ${longDateFmt.format(chat.createdAt)}\n\n`
  const meta =
    "`gpt-5.6-sol` (high) | 1s | $0 | 100 (80) -> 20 | 🌐×3 | **Stop reason:** max_tokens"
  const lastMeta = "`gpt-5.6-sol` | 1s | $0 | 1 -> 2 | 🌐"

  assert.deepEqual(
    chatToMd({ chat, lastN: 1 }),
    `${started}**System prompt:** Be brief.\n\n# assistant (4/4)\n\n${lastMeta}\n\nDone\n\n`,
  )
  assert.deepEqual(
    chatToMd({ chat, indices: [1], mode: "verbose" }),
    `${started}**System prompt:** Be brief.\n\n# assistant (2/4)\n\n${meta}\n\n> First\n> Second\n\nAnswer\n\n`,
  )
  assert.deepEqual(chatToMd({ chat, indices: [1, 3], mode: "raw" }), "Answer\n\nDone")
  assert.deepEqual(
    chatToMd({ chat, mode: "gist" }),
    [
      started,
      "<details>\n<summary>\nSystem prompt\n</summary>\n\n\nBe brief.\n</details>\n\n",
      "# user (1/4)\n\n",
      `<details>\n<summary>\nLong input collapsed\n</summary>\n\n\n${long}\n</details>\n\n\n\n`,
      `# assistant (2/4)\n\n${meta}\n\n`,
      "<details>\n<summary>\nReasoning\n</summary>\n\n\n> First\n> Second\n</details>\n\n",
      "Answer\n\n",
      // Input that already has a details block isn't wrapped in another
      `# user (3/4)\n\n${pasted}\n\n`,
      `# assistant (4/4)\n\n${lastMeta}\n\nDone\n\n`,
    ].join(""),
  )
})

test("messageContentMd escapes every think tag", () => {
  const msg = { ...assistantMessage(), content: "<think>a</think> then <think>b</think>" }
  assert.deepEqual(
    messageContentMd(msg, "verbose"),
    "`gpt-5.6-sol` | 1s | $0 | 1 -> 2\n\n\\<think>a\\</think> then \\<think>b\\</think>\n\n",
  )
})
