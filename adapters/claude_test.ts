import assert from "node:assert/strict"
import { test } from "node:test"

import { claudeThinkParams } from "./claude.ts"

test("Claude uses adaptive thinking with effort levels", () => {
  const params = claudeThinkParams("high")
  assert.deepEqual(params.thinking?.type, "adaptive")
  assert.deepEqual(params.output_config?.effort, "xhigh")
  assert.deepEqual(params.effort, "xhigh")
})

test("Claude defaults to medium effort on every model", () => {
  const params = claudeThinkParams(undefined)
  assert.deepEqual(params.thinking.type, "adaptive")
  assert.deepEqual(params.output_config, { effort: "medium" })
  assert.deepEqual(params.effort, "medium")
})
