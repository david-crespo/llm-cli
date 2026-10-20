import assert from "node:assert/strict"
import { test } from "node:test"

import { ThinkingLevel } from "@google/genai"

import { geminiThinkParams } from "./gemini.ts"

test("Gemini default sends MEDIUM, or MINIMAL on flash-lite", () => {
  assert.deepEqual(geminiThinkParams("gemini-4-argon", undefined), {
    thinkingLevel: ThinkingLevel.MEDIUM,
    effort: "medium",
  })
  assert.deepEqual(geminiThinkParams("gemini-3.5-flash-lite", undefined), {
    thinkingLevel: ThinkingLevel.MINIMAL,
    effort: "minimal",
  })
})

test("--quick only uses MINIMAL on flash-lite", () => {
  assert.deepEqual(geminiThinkParams("gemini-3.7-flash", "off").effort, "low")
  assert.deepEqual(geminiThinkParams("gemini-3.1-pro-preview", "off").effort, "low")
  assert.deepEqual(geminiThinkParams("gemini-3.5-flash-lite", "off").effort, "minimal")
})
