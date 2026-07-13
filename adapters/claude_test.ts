import { assertEquals } from "@std/assert"

import { claudeThinkParams } from "./claude.ts"

Deno.test("Sonnet 5 uses adaptive thinking with effort levels", () => {
  const params = claudeThinkParams("claude-sonnet-5", "high")
  assertEquals(params.thinking?.type, "adaptive")
  assertEquals(params.output_config?.effort, "xhigh")
  assertEquals(params.effort, "xhigh")
})

Deno.test("manual Claude thinking reports token budgets", () => {
  assertEquals(claudeThinkParams("claude-haiku-4-5", undefined).effort, "off")
  assertEquals(claudeThinkParams("claude-haiku-4-5", "on").effort, "4k")
})
