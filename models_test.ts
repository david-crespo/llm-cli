import { assertEquals, assertThrows } from "@std/assert"
import { ValidationError } from "@cliffy/command"
import { getCost, type Model, models, resolveModel } from "./models.ts"

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
  const model = resolveModel(undefined)
  assertEquals(model.default, true)
})

Deno.test("resolveModel - exact match on id", () => {
  const model = resolveModel("sonnet-4.5")
  assertEquals(model.id, "sonnet-4.5")
  assertEquals(model.key, "claude-sonnet-4-5")
})

Deno.test("resolveModel - exact match on key", () => {
  const model = resolveModel("claude-sonnet-4-5")
  assertEquals(model.id, "sonnet-4.5")
})

Deno.test("resolveModel - substring match on id", () => {
  const model = resolveModel("sonnet")
  assertEquals(model.id, "sonnet-4.5")
})

Deno.test("resolveModel - substring match on key", () => {
  const model = resolveModel("claude-opus")
  assertEquals(model.id, "opus-4.5")
})

Deno.test("resolveModel - case insensitive", () => {
  const model = resolveModel("SONNET")
  assertEquals(model.id, "sonnet-4.5")
})

Deno.test("resolveModel - throws on unknown model", () => {
  assertThrows(
    () => resolveModel("nonexistent-model-xyz"),
    ValidationError,
    "not found",
  )
})

Deno.test("Must have exactly one default model", () => {
  assertEquals(models.filter((m) => m.default).length, 1)
})
