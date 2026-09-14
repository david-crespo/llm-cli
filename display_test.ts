import { assertEquals } from "@std/assert"
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

Deno.test("formatElapsed - seconds only", () => {
  assertEquals(formatElapsed(5000), "5s")
  assertEquals(formatElapsed(30000), "30s")
})

Deno.test("formatElapsed - minutes and seconds", () => {
  assertEquals(formatElapsed(65000), "1m5s")
  assertEquals(formatElapsed(125000), "2m5s")
})

Deno.test("formatElapsed - fractional seconds", () => {
  assertEquals(formatElapsed(1500), "1.5s")
  assertEquals(formatElapsed(2750), "2.75s")
})

Deno.test("formatElapsed - fractional seconds truncated in minutes", () => {
  // 90.5 seconds = 1m30s (seconds truncated to integer when minutes > 0)
  assertEquals(formatElapsed(90500), "1m30s")
})

Deno.test("formatElapsed - zero", () => {
  assertEquals(formatElapsed(0), "0s")
})

Deno.test("formatElapsed - large values", () => {
  assertEquals(formatElapsed(3600000), "60m0s") // 1 hour
})

Deno.test("metaLineMd abbreviates known reasoning efforts", () => {
  assertEquals(
    metaLineMd(assistantMessage("minimal")).startsWith("`gpt-5.6-sol` (min) |"),
    true,
  )
  assertEquals(
    metaLineMd(assistantMessage("medium")).startsWith("`gpt-5.6-sol` (med) |"),
    true,
  )
})

Deno.test("metaLineMd passes through unknown efforts and preserves legacy output", () => {
  assertEquals(
    metaLineMd(assistantMessage("future")),
    "`gpt-5.6-sol` (future) | 1s | $0 | 1 -> 2",
  )
  assertEquals(metaLineMd(assistantMessage()), "`gpt-5.6-sol` | 1s | $0 | 1 -> 2")
})

Deno.test("chatToMd ignores date differences in the default system prompt", () => {
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
  assertEquals(chatToMd({ chat }).includes("**System prompt:**"), false)

  // A genuinely customized prompt is still reported.
  const chatCustom: Chat = { ...chat, systemPrompt: stalePrompt + "\n- extra" }
  assertEquals(chatToMd({ chat: chatCustom }).includes("**System prompt:**"), true)
})
