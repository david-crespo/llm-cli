import assert from "node:assert/strict"
import { test } from "node:test"

import { ValidationError } from "./errors.ts"
import { parseMessageSpec } from "./message-spec.ts"
import { errorIncluding } from "./testing.ts"

test("parseMessageSpec - single number", () => {
  assert.deepEqual(parseMessageSpec("3", 5), [2])
})

test("parseMessageSpec - multiple numbers", () => {
  assert.deepEqual(parseMessageSpec("1,3,5", 5), [0, 2, 4])
})

test("parseMessageSpec - range", () => {
  assert.deepEqual(parseMessageSpec("2-4", 5), [1, 2, 3])
})

test("parseMessageSpec - mixed numbers and ranges", () => {
  assert.deepEqual(parseMessageSpec("1,3-4,7", 10), [0, 2, 3, 6])
})

test("parseMessageSpec - even keyword", () => {
  // 1-based even message numbers 2,4,6 -> 0-based
  assert.deepEqual(parseMessageSpec("even", 6), [1, 3, 5])
})

test("parseMessageSpec - odd keyword", () => {
  // 1-based odd message numbers 1,3,5 -> 0-based
  assert.deepEqual(parseMessageSpec("odd", 6), [0, 2, 4])
})

test("parseMessageSpec - even/odd combine with numbers and dedupe", () => {
  assert.deepEqual(parseMessageSpec("odd,2", 5), [0, 1, 2, 4])
})

test("parseMessageSpec - out of order input returns sorted", () => {
  assert.deepEqual(parseMessageSpec("7,1,3-4", 10), [0, 2, 3, 6])
})

test("parseMessageSpec - duplicates are deduplicated", () => {
  assert.deepEqual(parseMessageSpec("1,1,2-3,3", 5), [0, 1, 2])
})

test("parseMessageSpec - whitespace is tolerated", () => {
  assert.deepEqual(parseMessageSpec(" 1 , 3 - 4 , 7 ", 10), [0, 2, 3, 6])
})

test("parseMessageSpec - range start > end throws", () => {
  assert.throws(
    () => parseMessageSpec("4-2", 5),
    errorIncluding(ValidationError, "Invalid range: start > end"),
  )
})

test("parseMessageSpec - message number too high throws", () => {
  assert.throws(
    () => parseMessageSpec("1,10", 5),
    errorIncluding(ValidationError, "Message 10 does not exist (chat has 5 messages)"),
  )
})

test("parseMessageSpec - message number 0 throws", () => {
  assert.throws(
    () => parseMessageSpec("0", 5),
    errorIncluding(ValidationError, "Message 0 does not exist"),
  )
})

test("parseMessageSpec - invalid number throws", () => {
  assert.throws(
    () => parseMessageSpec("abc", 5),
    errorIncluding(ValidationError, "Invalid message number"),
  )
})

test("parseMessageSpec - invalid number suffix throws", () => {
  assert.throws(
    () => parseMessageSpec("1abc", 5),
    errorIncluding(ValidationError, 'Invalid message number: "1abc"'),
  )
})

test("parseMessageSpec - decimal number throws", () => {
  assert.throws(
    () => parseMessageSpec("1.5", 5),
    errorIncluding(ValidationError, 'Invalid message number: "1.5"'),
  )
})

test("parseMessageSpec - invalid range throws", () => {
  assert.throws(
    () => parseMessageSpec("a-b", 5),
    errorIncluding(ValidationError, "Invalid range"),
  )
})

test("parseMessageSpec - invalid range suffix throws", () => {
  assert.throws(
    () => parseMessageSpec("1-2-3", 5),
    errorIncluding(ValidationError, 'Invalid range: "1-2-3"'),
  )
})
