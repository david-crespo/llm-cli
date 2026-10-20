import { assertEquals } from "@std/assert"

import { claudeThinkParams } from "./claude.ts"

Deno.test("Claude uses adaptive thinking with effort levels", () => {
  const params = claudeThinkParams("high")
  assertEquals(params.thinking?.type, "adaptive")
  assertEquals(params.output_config?.effort, "xhigh")
  assertEquals(params.effort, "xhigh")
})

Deno.test("Claude leaves effort at the API default unless asked", () => {
  const params = claudeThinkParams(undefined)
  assertEquals(params.thinking.type, "adaptive")
  assertEquals(params.output_config, undefined)
  assertEquals(params.max_tokens, 20_000)
  assertEquals(claudeThinkParams("off").max_tokens, 8_000)
})
