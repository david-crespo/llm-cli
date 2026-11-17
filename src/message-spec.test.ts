import assert from "node:assert/strict"
import { test } from "node:test"

import { ValidationError } from "./errors.ts"
import { parseMessageSpec } from "./message-spec.ts"
import { errorIncluding } from "./testing.ts"

test("parseMessageSpec - valid specs become sorted, deduplicated, 0-based indices", () => {
  const cases: Array<[string, number, number[]]> = [
    ["1,3-4,7", 10, [0, 2, 3, 6]],
    ["even", 6, [1, 3, 5]],
    ["odd", 6, [0, 2, 4]],
    ["odd,2", 5, [0, 1, 2, 4]],
    [" 7 , 1,1 , 3 - 4 , 3 ", 10, [0, 2, 3, 6]],
  ]
  for (const [spec, count, expected] of cases) {
    assert.deepEqual(parseMessageSpec(spec, count), expected, spec)
  }
})

test("parseMessageSpec - invalid specs throw", () => {
  const cases: Array<[string, string]> = [
    ["4-2", 'Invalid range: start > end in "4-2"'],
    ["1,10", "Message 10 does not exist (chat has 5 messages)"],
    ["0", "Message 0 does not exist"],
    ["1.5", 'Invalid message number: "1.5"'],
    ["1-2-3", 'Invalid range: "1-2-3"'],
  ]
  for (const [spec, error] of cases) {
    assert.throws(() => parseMessageSpec(spec, 5), errorIncluding(ValidationError, error))
  }
})
