import { assertEquals } from "@std/assert"
import { formatElapsed } from "./display.ts"

Deno.test("formatElapsed - seconds only", () => {
  assertEquals(formatElapsed(5000), "5s")
  assertEquals(formatElapsed(30000), "30s")
})

Deno.test("formatElapsed - minutes and seconds", () => {
  assertEquals(formatElapsed(65000), "1m5s")
  assertEquals(formatElapsed(125000), "2m5s")
})

Deno.test("formatElapsed - fractional seconds", () => {
  assertEquals(formatElapsed(1500), "1.5s")
  assertEquals(formatElapsed(2750), "2.75s")
})

Deno.test("formatElapsed - fractional seconds truncated in minutes", () => {
  // 90.5 seconds = 1m30s (seconds truncated to integer when minutes > 0)
  assertEquals(formatElapsed(90500), "1m30s")
})

Deno.test("formatElapsed - zero", () => {
  assertEquals(formatElapsed(0), "0s")
})

Deno.test("formatElapsed - large values", () => {
  assertEquals(formatElapsed(3600000), "60m0s") // 1 hour
})
