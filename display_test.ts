import { assertEquals } from "@std/assert"
import { formatElapsed, metaLineMd } from "./display.ts"
import type { ChatMessage } from "./types.ts"

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
