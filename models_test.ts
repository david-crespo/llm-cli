import assert from "node:assert/strict"
import { test } from "node:test"
import { assertAlmostEqual, errorIncluding } from "./testing.ts"
import { ValidationError } from "./errors.ts"
import { getCost, type Model, models, resolveModel } from "./models.ts"

const testModels: Model[] = [
  {
    provider: "test",
    key: "vendor-alpha-pro",
    id: "alpha-pro",
    input: 1,
    output: 1,
  },
  {
    provider: "test",
    key: "vendor-alpha-fast",
    id: "alpha-fast",
    input: 1,
    output: 1,
  },
  {
    provider: "test",
    key: "vendor-alpha",
    id: "alpha",
    default: true,
    input: 1,
    output: 1,
  },
]

// getCost tests

test("getCost - basic calculation without caching", () => {
  const model: Model = {
    provider: "test",
    key: "test-model",
    id: "test",
    input: 3, // $3 per million
    output: 15, // $15 per million
  }
  const tokens = { input: 1000, output: 500 }
  // (3 * 1000 + 15 * 500) / 1_000_000 = 10500 / 1_000_000 = 0.0105
  assert.deepEqual(getCost(model, tokens), 0.0105)
})

test("getCost - with cache hit pricing", () => {
  const model: Model = {
    provider: "test",
    key: "test-model",
    id: "test",
    input: 3,
    input_cached: 0.3,
    output: 15,
  }
  const tokens = { input: 1000, input_cache_hit: 800, output: 500 }
  // cached: 0.3 * 800 = 240
  // uncached: 3 * (1000 - 800) = 600
  // output: 15 * 500 = 7500
  // total: (240 + 600 + 7500) / 1_000_000 = 0.00834
  assert.deepEqual(getCost(model, tokens), 0.00834)
})

test("getCost - cache hit but no cached pricing uses regular input price", () => {
  const model: Model = {
    provider: "test",
    key: "test-model",
    id: "test",
    input: 3,
    output: 15,
    // no input_cached price
  }
  const tokens = { input: 1000, input_cache_hit: 800, output: 500 }
  // Falls back to regular calculation since no input_cached price
  // (3 * 1000 + 15 * 500) / 1_000_000 = 0.0105
  assert.deepEqual(getCost(model, tokens), 0.0105)
})

test("getCost - cache writes priced at write rate", () => {
  const model: Model = {
    provider: "test",
    key: "test-model",
    id: "test",
    input: 4,
    input_cached: 0.4,
    input_cache_write: 5,
    output: 20,
  }
  const tokens = { input: 1000, input_cache_hit: 600, input_cache_write: 300, output: 100 }
  // hits: 0.4 * 600 = 240
  // writes: 5 * 300 = 1500
  // uncached: 4 * (1000 - 600 - 300) = 400
  // output: 20 * 100 = 2000
  // total: (240 + 1500 + 400 + 2000) / 1_000_000 = 0.00414
  assert.deepEqual(getCost(model, tokens), 0.00414)
})

test("getCost - cache writes without write pricing use input price", () => {
  const model: Model = {
    provider: "test",
    key: "test-model",
    id: "test",
    input: 4,
    output: 20,
  }
  const tokens = { input: 1000, input_cache_write: 300, output: 100 }
  // (4 * 1000 + 20 * 100) / 1_000_000 = 0.006
  assert.deepEqual(getCost(model, tokens), 0.006)
})

test("getCost - adds the search cost per search", () => {
  const model: Model = {
    provider: "test",
    key: "test-model",
    id: "test",
    input: 3,
    output: 15,
    search_cost: 0.01,
  }
  // 0.0105 for tokens, as above, plus 3 searches at $0.01
  assertAlmostEqual(getCost(model, { input: 1000, output: 500 }, 3), 0.0405)
})

test("getCost - Haiku 5.5 prices every token type at 5x over 100k input", () => {
  const model: Model = {
    provider: "test",
    key: "claude-haiku-5-5",
    id: "test",
    input: 1,
    input_cached: 0.1,
    output: 5,
  }
  const short = { input: 100_000, input_cache_hit: 50_000, output: 1000 }
  // (0.1 * 50_000 + 1 * 50_000 + 5 * 1000) / 1_000_000
  assertAlmostEqual(getCost(model, short), 0.06)
  const long = { input: 100_001, input_cache_hit: 50_000, output: 1000 }
  // 5 * (0.1 * 50_000 + 1 * 50_001 + 5 * 1000) / 1_000_000
  assertAlmostEqual(getCost(model, long), 0.300005)
})

test("getCost - image output tokens use the image price", () => {
  const model: Model = {
    provider: "test",
    key: "test-image",
    id: "test",
    kind: "image",
    input: 1,
    output: 10,
    output_image: 40,
  }
  const tokens = { input: 10, output: 2007, output_image: 1120 }
  // (1 * 10 + 40 * 1120 + 10 * 887) / 1_000_000
  assertAlmostEqual(getCost(model, tokens), 0.05368)
})

test("resolveModel - matches id or key exactly, then by substring, ignoring case", () => {
  const cases: Array<[string | undefined, Model]> = [
    [undefined, testModels[2]],
    ["alpha", testModels[2]],
    ["vendor-alpha", testModels[2]],
    ["alpha-", testModels[0]],
    ["vendor-alpha-", testModels[0]],
    ["ALPHA-", testModels[0]],
  ]
  for (const [arg, expected] of cases) {
    assert.deepEqual(resolveModel(arg, testModels), expected, String(arg))
  }
  assert.throws(
    () => resolveModel("nonexistent-model-xyz", testModels),
    errorIncluding(ValidationError, "not found"),
  )
})

test("Must have exactly one default model", () => {
  assert.deepEqual(models.filter((m) => m.default).length, 1)
})

// Modules that resolve hard-coded aliases at module scope (like
// resolveModel("flash") in summarize.ts) throw on import if catalog churn
// makes the alias stop matching. Importing them here catches that.
test("modules with hard-coded model aliases import cleanly", async () => {
  await import("./summarize.ts")
})

test("image models resolve by nickname without shadowing text models", () => {
  assert.deepEqual(resolveModel("flare").key, "gpt-image-2.6-flare")
  assert.deepEqual(resolveModel("sunburst").key, "gpt-image-2.6-sunburst")
  assert.deepEqual(resolveModel("gpt").kind, undefined)
  assert.deepEqual(resolveModel("banana").key, "gemini-nano-banana-2.1")
  assert.deepEqual(resolveModel("gemini").kind, undefined)
})
