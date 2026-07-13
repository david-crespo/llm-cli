import { assertEquals } from "@std/assert"

import { openAIEffort } from "./openai.ts"

Deno.test("OpenAI reasoning intent resolves to native effort", () => {
  assertEquals(openAIEffort(undefined), "medium")
  assertEquals(openAIEffort("high"), "high")
  assertEquals(openAIEffort("off"), "none")
})
