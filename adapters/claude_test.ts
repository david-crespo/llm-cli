import { assertEquals } from "@std/assert"

import { claudeThinkParams } from "./claude.ts"

Deno.test("Sonnet 5 uses adaptive thinking with effort levels", () => {
  const params = claudeThinkParams("claude-sonnet-5", "high")
  assertEquals(params.thinking?.type, "adaptive")
  assertEquals(params.output_config?.effort, "xhigh")
})
