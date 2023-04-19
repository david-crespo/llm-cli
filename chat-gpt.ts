#! /usr/bin/env -S deno run --allow-env --allow-read --allow-net --allow-write
import { getStdin } from "./utils/get-stdin.ts"
import { getOpenAIApi } from "./utils/open-ai-api.ts"
import { type JSONValue } from "https://deno.land/std@0.153.0/encoding/jsonc.ts"
import * as flags from "https://deno.land/std@0.184.0/flags/mod.ts"
import * as z from "https://deno.land/x/zod@v3.21.4/mod.ts"

const Message = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
})

// TODO: helper for history.json path that makes it work when run from anywhere

function getHistory() {
  return z.array(Message).parse(JSON.parse(
    new TextDecoder("utf-8").decode(Deno.readFileSync("./history.json")),
  ))
}

function jsonMd(obj: JSONValue) {
  return "\n```json\n" + JSON.stringify(obj, null, 2) + "\n```\n\n"
}

const args = flags.parse(Deno.args, { boolean: ["r"] })
const directInput = args._[0].toString()
const input = directInput === "-" ? await getStdin() : directInput

// TODO: Add a first argument that selects from a set of system messages
// TODO: It doesn't seem to care too much about the system message, try adding a prelude to the prompt instead
const systemMsg = {
  role: "system",
  content:
    "You are an experienced software developer. Your answers are precise, concise, and avoid jargon and filler. Answer only the question as asked, do not assume more background is desired. Go right into the answer; do not start by repeating or rephrasing the input question. Your answers should be in markdown format.",
} as const

const userMsg = { role: "user", content: input } as const

// r for reply
const messages = args.r ? [...getHistory(), userMsg] : [systemMsg, userMsg]

const openai = await getOpenAIApi(import.meta.url)

const resp = await openai.createChatCompletion({
  model: "gpt-3.5-turbo",
  messages,
}).catch((e) => {
  console.log("Request error:", e.response.status)
  console.log(jsonMd(e.response.data))
  Deno.exit()
})

const respMsg = resp.data.choices[0].message

if (respMsg) {
  const newHistory = JSON.stringify([...messages, respMsg], null, 2)
  Deno.writeFileSync("./history.json", new TextEncoder().encode(newHistory))

  console.log(respMsg.content)
}
