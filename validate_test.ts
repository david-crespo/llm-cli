import { assertEquals } from "@std/assert"

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

Deno.test("plain prompt is fine for every model", () => {
  for (const m of ["opus", "gpt-6.1-sol", "gemini-3.8-flash", "flare"]) {
    assertEquals(requestProblems(resolveModel(m), flags()), [])
  }
})

Deno.test("image models list every unsupported flag in one problem", () => {
  const req = flags({ config: { search: true, think: "high" }, images: true })
  assertEquals(requestProblems(resolveModel("flare"), req), [
    "Not supported for image models: --image, --search, thinking flags",
  ])
})

Deno.test("image options only apply to image models", () => {
  assertEquals(requestProblems(resolveModel("flare"), flags({ quality: "low" })), [])
  assertEquals(requestProblems(resolveModel("opus"), flags({ size: "auto" })), [
    "--quality and --size only apply to image models",
  ])
  assertEquals(requestProblems(resolveModel("flare"), flags({ size: "big" })), [
    "Invalid size 'big'. Use WIDTHxHEIGHT or auto",
  ])
})

Deno.test("background reports every problem", () => {
  const req = flags({ background: true, outputSchema: true })
  assertEquals(requestProblems(resolveModel("opus"), req), [
    "Background mode only works with OpenAI models",
    "Structured output is not supported in background mode",
  ])
  assertEquals(requestProblems(resolveModel("gpt-6.1-sol"), req), [
    "Structured output is not supported in background mode",
  ])
})
