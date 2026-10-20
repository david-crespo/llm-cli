import assert from "node:assert/strict"
import { test } from "node:test"
import process from "node:process"
import { errorIncluding } from "./testing.ts"
import { ValidationError } from "./errors.ts"
import { getApiKey } from "./config.ts"

function withEnv(name: string, value: string | undefined, fn: () => void) {
  const old = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    fn()
  } finally {
    if (old === undefined) delete process.env[name]
    else process.env[name] = old
  }
}

test("getApiKey reads the provider's env var", () => {
  withEnv("ANTHROPIC_API_KEY", "sk-ant-test", () => {
    assert.deepEqual(getApiKey("anthropic"), "sk-ant-test")
  })
})

test("getApiKey reads GEMINI_API_KEY for google", () => {
  withEnv("GEMINI_API_KEY", "gemini-test", () => {
    assert.deepEqual(getApiKey("google"), "gemini-test")
  })
})

test("getApiKey names the env var when it's missing or empty", () => {
  for (const value of [undefined, ""]) {
    withEnv("OPENAI_API_KEY", value, () => {
      assert.throws(
        () => getApiKey("openai"),
        errorIncluding(ValidationError, "OPENAI_API_KEY is not set"),
      )
    })
  }
})

test("getApiKey rejects an unknown provider", () => {
  assert.throws(() => getApiKey("nope"), errorIncluding(Error, "'nope'"))
})
