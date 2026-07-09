import { assertEquals, assertThrows } from "@std/assert"
import { ValidationError } from "@cliffy/command"
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

Deno.test("getCost - basic calculation without caching", () => {
  const model: Model = {
    provider: "test",
    key: "test-model",
    id: "test",
    input: 3, // $3 per million
    output: 15, // $15 per million
  }
  const tokens = { input: 1000, output: 500 }
  // (3 * 1000 + 15 * 500) / 1_000_000 = 10500 / 1_000_000 = 0.0105
  assertEquals(getCost(model, tokens), 0.0105)
})

Deno.test("getCost - with cache hit pricing", () => {
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
  assertEquals(getCost(model, tokens), 0.00834)
})

Deno.test("getCost - cache hit but no cached pricing uses regular input price", () => {
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
  assertEquals(getCost(model, tokens), 0.0105)
})

Deno.test("getCost - zero tokens", () => {
  const model: Model = {
    provider: "test",
    key: "test-model",
    id: "test",
    input: 3,
    output: 15,
  }
  const tokens = { input: 0, output: 0 }
  assertEquals(getCost(model, tokens), 0)
})

// resolveModel tests

Deno.test("resolveModel - returns default when undefined", () => {
  assertEquals(resolveTestModel(undefined), testModels[2])
})

Deno.test("resolveModel - exact match on id", () => {
  assertEquals(resolveTestModel("alpha"), testModels[2])
})

Deno.test("resolveModel - exact match on key", () => {
  assertEquals(resolveTestModel("vendor-alpha"), testModels[2])
})

Deno.test("resolveModel - substring match on id", () => {
  assertEquals(resolveTestModel("alpha-"), testModels[0])
})

Deno.test("resolveModel - substring match on key", () => {
  assertEquals(resolveTestModel("vendor-alpha-"), testModels[0])
})

Deno.test("resolveModel - case insensitive", () => {
  assertEquals(resolveTestModel("ALPHA-"), testModels[0])
})

Deno.test("resolveModel - throws on unknown model", () => {
  assertThrows(
    () => resolveTestModel("nonexistent-model-xyz"),
    ValidationError,
    "not found",
  )
})

Deno.test("Must have exactly one default model", () => {
  assertEquals(models.filter((m) => m.default).length, 1)
})

// Modules that resolve hard-coded aliases at module scope (like
// resolveModel("flash") in summarize.ts) throw on import if catalog churn
// makes the alias stop matching. Importing them here catches that.
Deno.test("modules with hard-coded model aliases import cleanly", async () => {
  await import("./summarize.ts")
})
