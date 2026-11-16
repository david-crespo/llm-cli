import assert from "node:assert/strict"
import { test } from "node:test"

import { claudeThinkParams } from "./claude.ts"

test("Claude uses adaptive thinking with effort levels", () => {
  const params = claudeThinkParams("high")
  assert.deepEqual(params.thinking?.type, "adaptive")
  assert.deepEqual(params.output_config?.effort, "xhigh")
  assert.deepEqual(params.effort, "xhigh")
})

test("Claude leaves effort at the API default unless asked", () => {
  const params = claudeThinkParams(undefined)
  assert.deepEqual(params.thinking.type, "adaptive")
  assert.deepEqual(params.output_config, undefined)
})
