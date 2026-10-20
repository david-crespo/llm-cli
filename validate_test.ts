import assert from "node:assert/strict"
import { test } from "node:test"

import { resolveModel } from "./models.ts"
import { type RequestFlags, requestProblems } from "./validate.ts"

const flags = (overrides: Partial<RequestFlags> = {}): RequestFlags => ({
  reply: false,
  system: false,
  images: false,
  config: { search: false, think: undefined },
  outputSchema: false,
  background: false,
  ...overrides,
})

test("plain prompt is fine for every model", () => {
  for (const m of ["opus", "gpt-6.1-sol", "gemini-3.8-flash", "flare"]) {
    assert.deepEqual(requestProblems(resolveModel(m), flags()), [])
  }
})

test("image models list every unsupported flag in one problem", () => {
  const req = flags({ config: { search: true, think: "high" }, images: true })
  assert.deepEqual(requestProblems(resolveModel("flare"), req), [
    "Not supported for image models: --image, --search, thinking flags",
  ])
})

test("image options only apply to image models", () => {
  assert.deepEqual(requestProblems(resolveModel("flare"), flags({ quality: "low" })), [])
  assert.deepEqual(requestProblems(resolveModel("opus"), flags({ size: "auto" })), [
    "--quality and --size only apply to image models",
  ])
  assert.deepEqual(requestProblems(resolveModel("flare"), flags({ size: "big" })), [
    "Invalid size 'big'. Use WIDTHxHEIGHT or auto",
  ])
})

test("background reports every problem", () => {
  const req = flags({ background: true, outputSchema: true })
  assert.deepEqual(requestProblems(resolveModel("opus"), req), [
    "Background mode only works with OpenAI models",
    "Structured output is not supported in background mode",
  ])
  assert.deepEqual(requestProblems(resolveModel("gpt-6.1-sol"), req), [
    "Structured output is not supported in background mode",
  ])
})
