import assert from "node:assert/strict"
import { test } from "node:test"

import { testModel } from "./testing.ts"
import { type RequestFlags, requestProblems } from "./validate.ts"

const claude = testModel("anthropic")
const gpt = testModel("openai")
const gemini = testModel("google")
const gptImage = testModel("openai", "image")
const geminiImage = testModel("google", "image")

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
  for (const m of [claude, gpt, gemini, gptImage, geminiImage]) {
    assert.deepEqual(requestProblems(m, flags()), [])
  }
})

test("image models list every unsupported flag in one problem", () => {
  const req = flags({ config: { search: true, think: "high" }, images: true })
  assert.deepEqual(requestProblems(gptImage, req), [
    "Not supported for image models: --image, --search, thinking flags",
  ])
  assert.deepEqual(requestProblems(geminiImage, req), [
    "Not supported for image models: --image, --search",
  ])
})

test("image models take only a fresh prompt", () => {
  const req = flags({ reply: true, system: true, outputSchema: true, background: true })
  assert.deepEqual(requestProblems(gptImage, req), [
    "Not supported for image models: -r (use -m to pick a text model), --system, --output-schema, --background",
    "Structured output is not supported in background mode",
  ])
})

test("image options only apply to image models", () => {
  assert.deepEqual(requestProblems(gptImage, flags({ quality: "low" })), [])
  assert.deepEqual(requestProblems(claude, flags({ size: "auto" })), [
    "--quality, --size, and --aspect only apply to image models",
  ])
  assert.deepEqual(requestProblems(gptImage, flags({ size: "big" })), [
    "Invalid size 'big'. Use WIDTHxHEIGHT or auto",
  ])
  assert.deepEqual(requestProblems(geminiImage, flags({ size: "2K", aspect: "16:9" })), [])
  const banana = flags({ quality: "low", size: "2k", aspect: "wide" })
  assert.deepEqual(requestProblems(geminiImage, banana), [
    "--quality only applies to OpenAI image models",
    "Invalid size '2k'. Use 1K, 2K, or 4K",
    "Invalid aspect ratio 'wide'. Use W:H, e.g. 16:9",
  ])
  assert.deepEqual(requestProblems(gptImage, flags({ aspect: "16:9" })), [
    "--aspect only applies to Gemini image models",
  ])
})

test("background reports every problem", () => {
  const req = flags({ background: true, outputSchema: true })
  assert.deepEqual(requestProblems(claude, req), [
    "Background mode only works with OpenAI models",
    "Structured output is not supported in background mode",
  ])
  assert.deepEqual(requestProblems(gpt, req), [
    "Structured output is not supported in background mode",
  ])
})
