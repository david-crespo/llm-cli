import { assertEquals } from "@std/assert"

import { ThinkingLevel } from "@google/genai"

import { geminiThinkParams } from "./gemini.ts"

Deno.test("Gemini default sends MEDIUM, or MINIMAL on flash-lite", () => {
  assertEquals(geminiThinkParams("gemini-4-argon", undefined), {
    thinkingLevel: ThinkingLevel.MEDIUM,
    effort: "medium",
  })
  assertEquals(geminiThinkParams("gemini-3.5-flash-lite", undefined), {
    thinkingLevel: ThinkingLevel.MINIMAL,
    effort: "minimal",
  })
})

Deno.test("--quick only uses MINIMAL on flash-lite", () => {
  assertEquals(geminiThinkParams("gemini-3.7-flash", "off").effort, "low")
  assertEquals(geminiThinkParams("gemini-3.1-pro-preview", "off").effort, "low")
  assertEquals(
    geminiThinkParams("gemini-3.5-flash-lite", "off").effort,
    "minimal",
  )
})
