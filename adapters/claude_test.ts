import assert from "node:assert/strict"

import { claudeThinkParams } from "./claude.ts"

Deno.test("Claude uses adaptive thinking with effort levels", () => {
  const params = claudeThinkParams("high")
  assert.deepEqual(params.thinking?.type, "adaptive")
  assert.deepEqual(params.output_config?.effort, "xhigh")
  assert.deepEqual(params.effort, "xhigh")
})

Deno.test("Claude leaves effort at the API default unless asked", () => {
  const params = claudeThinkParams(undefined)
  assert.deepEqual(params.thinking.type, "adaptive")
  assert.deepEqual(params.output_config, undefined)
  assert.deepEqual(params.max_tokens, 20_000)
  assert.deepEqual(claudeThinkParams("off").max_tokens, 8_000)
})
