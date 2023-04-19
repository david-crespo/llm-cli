import { Configuration, OpenAIApi } from "npm:openai"

export function getOpenAIApi(apiKey: string | undefined) {
  if (!apiKey) {
    console.error("Error: OPENAI_API_KEY required in env")
    Deno.exit()
  }

  return new OpenAIApi(new Configuration({ apiKey }))
}
