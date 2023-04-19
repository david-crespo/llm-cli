import { loadEnv } from "./load-env.ts"
import { Configuration, OpenAIApi } from "npm:openai"

export async function getOpenAIApi(importMetaUrl: string) {
  const env = await loadEnv(importMetaUrl)

  if (!env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY required in env")
    Deno.exit()
  }

  return new OpenAIApi(new Configuration({ apiKey: env.OPENAI_API_KEY }))
}
