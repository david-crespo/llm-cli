import { assertEquals } from "@std/assert"

import { resolveThink } from "./types.ts"

Deno.test("resolveThink inherits, replaces, and clears sticky state", () => {
  assertEquals(resolveThink(undefined, "high"), "high")
  assertEquals(resolveThink("off", "high"), "off")
  assertEquals(resolveThink("default", "high"), undefined)
})
