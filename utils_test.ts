import { assertEquals, assertThrows } from "@std/assert"
import { ValidationError } from "@cliffy/command"
import { parseMessageSpec } from "./utils.ts"

Deno.test("parseMessageSpec - single number", () => {
  assertEquals(parseMessageSpec("3", 5), [2])
})

Deno.test("parseMessageSpec - multiple numbers", () => {
  assertEquals(parseMessageSpec("1,3,5", 5), [0, 2, 4])
})

Deno.test("parseMessageSpec - range", () => {
  assertEquals(parseMessageSpec("2-4", 5), [1, 2, 3])
})

Deno.test("parseMessageSpec - mixed numbers and ranges", () => {
  assertEquals(parseMessageSpec("1,3-4,7", 10), [0, 2, 3, 6])
})

Deno.test("parseMessageSpec - out of order input returns sorted", () => {
  assertEquals(parseMessageSpec("7,1,3-4", 10), [0, 2, 3, 6])
})

Deno.test("parseMessageSpec - duplicates are deduplicated", () => {
  assertEquals(parseMessageSpec("1,1,2-3,3", 5), [0, 1, 2])
})

Deno.test("parseMessageSpec - whitespace is tolerated", () => {
  assertEquals(parseMessageSpec(" 1 , 3 - 4 , 7 ", 10), [0, 2, 3, 6])
})

Deno.test("parseMessageSpec - range start > end throws", () => {
  assertThrows(
    () => parseMessageSpec("4-2", 5),
    ValidationError,
    "Invalid range: start > end",
  )
})

Deno.test("parseMessageSpec - message number too high throws", () => {
  assertThrows(
    () => parseMessageSpec("1,10", 5),
    ValidationError,
    "Message 10 does not exist (chat has 5 messages)",
  )
})

Deno.test("parseMessageSpec - message number 0 throws", () => {
  assertThrows(
    () => parseMessageSpec("0", 5),
    ValidationError,
    "Message 0 does not exist",
  )
})

Deno.test("parseMessageSpec - invalid number throws", () => {
  assertThrows(
    () => parseMessageSpec("abc", 5),
    ValidationError,
    "Invalid message number",
  )
})

Deno.test("parseMessageSpec - invalid range throws", () => {
  assertThrows(
    () => parseMessageSpec("a-b", 5),
    ValidationError,
    "Invalid range",
  )
})
