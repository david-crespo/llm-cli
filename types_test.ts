import assert from "node:assert/strict"

import { resolveThink } from "./types.ts"

Deno.test("resolveThink inherits, replaces, and clears sticky state", () => {
  assert.deepEqual(resolveThink(undefined, "high"), "high")
  assert.deepEqual(resolveThink("off", "high"), "off")
  assert.deepEqual(resolveThink("default", "high"), undefined)
})
