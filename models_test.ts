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

function resolveTestModel(modelArg: string | undefined) {
  return resolveModel(modelArg, testModels)
}

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

test("getCost - long context prices apply over threshold", () => {
  const model = resolveModel("haiku-5.5")
  const short = { input: 100_000, input_cache_hit: 50_000, output: 1000 }
  // (0.01 * 50_000 + 0.10 * 50_000 + 0.50 * 1000) / 1_000_000
  assertAlmostEqual(getCost(model, short), 0.006)
  const long = { input: 100_001, input_cache_hit: 50_000, output: 1000 }
  // (0.05 * 50_000 + 0.50 * 50_001 + 2.50 * 1000) / 1_000_000
  assertAlmostEqual(getCost(model, long), 0.0300005)
})

test("getCost - zero tokens", () => {
  const model: Model = {
    provider: "test",
    key: "test-model",
    id: "test",
    input: 3,
    output: 15,
  }
  const tokens = { input: 0, output: 0 }
  assert.deepEqual(getCost(model, tokens), 0)
})

// resolveModel tests

test("resolveModel - returns default when undefined", () => {
  assert.deepEqual(resolveTestModel(undefined), testModels[2])
})

test("resolveModel - exact match on id", () => {
  assert.deepEqual(resolveTestModel("alpha"), testModels[2])
})

test("resolveModel - exact match on key", () => {
  assert.deepEqual(resolveTestModel("vendor-alpha"), testModels[2])
})

test("resolveModel - substring match on id", () => {
  assert.deepEqual(resolveTestModel("alpha-"), testModels[0])
})

test("resolveModel - substring match on key", () => {
  assert.deepEqual(resolveTestModel("vendor-alpha-"), testModels[0])
})

test("resolveModel - case insensitive", () => {
  assert.deepEqual(resolveTestModel("ALPHA-"), testModels[0])
})

test("resolveModel - throws on unknown model", () => {
  assert.throws(
    () => resolveTestModel("nonexistent-model-xyz"),
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
  assert.deepEqual(resolveModel("flare").key, "gpt-image-2.5-flare")
  assert.deepEqual(resolveModel("sunburst").key, "gpt-image-2.5-sunburst")
  assert.deepEqual(resolveModel("gpt").kind, undefined)
})
