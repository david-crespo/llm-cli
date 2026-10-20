import process from "node:process"

import { ValidationError } from "./errors.ts"

const envVars: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  // doesn't match the provider id
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
}

/** API key for `provider`, read from its env var */
export function getApiKey(provider: string): string {
  const envVar = envVars[provider]
  if (!envVar) throw new Error(`No API key env var for provider '${provider}'`)
  const key = process.env[envVar]
  if (!key) throw new ValidationError(`${envVar} is not set`)
  return key
}
