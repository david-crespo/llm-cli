import assert from "node:assert/strict"
import { test } from "node:test"

import { resolveThink } from "./types.ts"

test("resolveThink inherits, replaces, and clears sticky state", () => {
  assert.deepEqual(resolveThink(undefined, "high"), "high")
  assert.deepEqual(resolveThink("off", "high"), "off")
  assert.deepEqual(resolveThink("default", "high"), undefined)
})
