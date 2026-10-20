import assert from "node:assert/strict"
import { test } from "node:test"

import { pick, range, uniqueBy } from "./utils.ts"

test("range excludes the end and is empty when end <= start", () => {
  assert.deepEqual(range(2, 5), [2, 3, 4])
  assert.deepEqual(range(3, 3), [])
  assert.deepEqual(range(4, 1), [])
})

test("uniqueBy keeps the first item for each key", () => {
  const items = [{ k: "a", n: 1 }, { k: "b", n: 2 }, { k: "a", n: 3 }]
  assert.deepEqual(uniqueBy(items, (i) => i.k), [{ k: "a", n: 1 }, { k: "b", n: 2 }])
})

test("pick copies only the given keys", () => {
  assert.deepEqual(pick({ a: 1, b: 2, c: 3 }, ["a", "c"]), { a: 1, c: 3 })
})
