#! /usr/bin/env -S deno run --allow-env --allow-read --allow-net
import { getInput } from "./utils/get-input.ts"
import { ChatCompletionRequestMessage } from "npm:openai"
import { getOpenAIApi } from "./utils/open-ai-api.ts"

const input = await getInput()

const openai = await getOpenAIApi(import.meta.url)

// TODO: Add a first argument that selects from a set of system messages
// TODO: It doesn't seem to care too much about the system message, try adding a prelude to the prompt instead
const systemMsg = {
  role: "system",
  content:
    "You are an experienced software developer. Your answers are precise, concise, and avoid jargon and filler. Answer only the question as asked, do not assume more background is desired. Go right into the answer; do not start by repeating or rephrasing the input question. Your answers should be in markdown format.",
} satisfies ChatCompletionRequestMessage

const response = await openai.createChatCompletion({
  model: "gpt-3.5-turbo",
  messages: [systemMsg, { role: "user", content: input }],
}).catch((e) => {
  console.log("Request error:", e.response.status)
  console.log("\n```json\n" + JSON.stringify(e.response.data, null, 2) + "\n```")
  Deno.exit()
})

console.log(response.data.choices[0].message?.content)
