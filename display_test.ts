import assert from "node:assert/strict"
import { test } from "node:test"
import { chatToMd, formatElapsed, metaLineMd } from "./display.ts"
import { systemBase } from "./models.ts"
import type { Chat, ChatMessage } from "./types.ts"

const assistantMessage = (effort?: string): ChatMessage => ({
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

test("chatToMd includes every attached image in order", () => {
  const chat: Chat = {
    id: "images",
    createdAt: new Date(0),
    systemPrompt: systemBase,
    messages: [
      {
        role: "user",
        content: "Compare these",
        createdAt: new Date(0),
        image_urls: ["data:image/png;base64,AQID", "https://example.com/second.jpg"],
      },
    ],
  }
  const md = chatToMd({ chat })
  assert.deepEqual(
    md.includes("[Image 1 (inline)]\n\n[Image 2](https://example.com/second.jpg)"),
    true,
  )
})

test("formatElapsed - seconds only", () => {
  assert.deepEqual(formatElapsed(5000), "5s")
  assert.deepEqual(formatElapsed(30000), "30s")
})

test("formatElapsed - minutes and seconds", () => {
  assert.deepEqual(formatElapsed(65000), "1m5s")
  assert.deepEqual(formatElapsed(125000), "2m5s")
})

test("formatElapsed - fractional seconds", () => {
  assert.deepEqual(formatElapsed(1500), "1.5s")
  assert.deepEqual(formatElapsed(2750), "2.75s")
})

test("formatElapsed - fractional seconds truncated in minutes", () => {
  // 90.5 seconds = 1m30s (seconds truncated to integer when minutes > 0)
  assert.deepEqual(formatElapsed(90500), "1m30s")
})

test("formatElapsed - zero", () => {
  assert.deepEqual(formatElapsed(0), "0s")
})

test("formatElapsed - large values", () => {
  assert.deepEqual(formatElapsed(3600000), "60m0s") // 1 hour
})

test("metaLineMd abbreviates known reasoning efforts", () => {
  assert.deepEqual(
    metaLineMd(assistantMessage("minimal")).startsWith("`gpt-5.6-sol` (min) |"),
    true,
  )
  assert.deepEqual(
    metaLineMd(assistantMessage("medium")).startsWith("`gpt-5.6-sol` (med) |"),
    true,
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
  assert.deepEqual(chatToMd({ chat }).includes("**System prompt:**"), false)

  // A genuinely customized prompt is still reported.
  const chatCustom: Chat = { ...chat, systemPrompt: stalePrompt + "\n- extra" }
  assert.deepEqual(chatToMd({ chat: chatCustom }).includes("**System prompt:**"), true)
})
