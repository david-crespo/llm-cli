#! /usr/bin/env -S deno run --allow-env --allow-read --allow-net --allow-write
import { load as loadEnv } from "https://deno.land/std@0.184.0/dotenv/mod.ts"
import * as flags from "https://deno.land/std@0.184.0/flags/mod.ts"
import * as z from "https://deno.land/x/zod@v3.21.4/mod.ts"
import { Configuration, OpenAIApi } from "npm:openai"

import { getStdin, jsonBlock } from "./utils/mod.ts"

const args = flags.parse(Deno.args, { boolean: ["r", "h"] })

if (args.h) {
  console.log(`-r to continue ongoing conversation. no flag to start a new conversation`)
  Deno.exit()
}

const Env = z.object({ OPENAI_API_KEY: z.string().min(1) })
const envPath = new URL(".env", import.meta.url).pathname
const env = Env.parse(await loadEnv({ envPath }))
const openai = new OpenAIApi(new Configuration({ apiKey: env.OPENAI_API_KEY }))

const Message = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
})

const HISTORY_KEY = "history"

function getHistory() {
  const contents = localStorage.getItem(HISTORY_KEY)
  if (!contents) return null
  return z.array(Message).parse(JSON.parse(contents))
}

const directInput = args._.join(" ")
const input = directInput === "-" ? await getStdin() : directInput

// TODO: Add an argument that selects from a set of system messages
const systemMsg = {
  role: "system",
  content: `
    You are an experienced software developer.
    Your answers are precise, concise, and avoid jargon and filler.
    Answer only the question as asked, do not give extra background.
    Go right into the answer. Your answers should be in markdown format.
  `.trim(),
} as const

const userMsg = { role: "user", content: input } as const

// r for reply
const history = getHistory()
const messages = args.r && history ? [...history, userMsg] : [systemMsg, userMsg]

const resp = await openai.createChatCompletion({
  model: "gpt-4",
  messages,
}).catch((e) => {
  console.log("Request error:", e.response.status)
  console.log(jsonBlock(e.response.data))
  Deno.exit()
})

const respMsg = resp.data.choices[0].message

if (respMsg) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify([...messages, respMsg]))
  console.log(respMsg.content)
}
