import { assertEquals } from "@std/assert"

import { geminiThinkParams } from "./gemini.ts"

Deno.test("Gemini defaults resolve to model-specific display levels", () => {
  assertEquals(
    geminiThinkParams("gemini-3.1-pro-preview", undefined).effort,
    "high",
  )
  assertEquals(geminiThinkParams("gemini-3.5-flash", undefined).effort, "medium")
  assertEquals(
    geminiThinkParams("gemini-3.1-flash-lite-preview", undefined).effort,
    "minimal",
  )
})

Deno.test("--quick only uses MINIMAL on flash-lite", () => {
  assertEquals(geminiThinkParams("gemini-3.7-flash", "off").effort, "low")
  assertEquals(geminiThinkParams("gemini-3.1-pro-preview", "off").effort, "low")
  assertEquals(
    geminiThinkParams("gemini-3.5-flash-lite", "off").effort,
    "minimal",
  )
})
