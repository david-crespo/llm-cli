#! /usr/bin/env -S deno run --allow-env --allow-read --allow-net --allow-write
import { load as loadEnv } from "https://deno.land/std@0.184.0/dotenv/mod.ts"
import * as flags from "https://deno.land/std@0.184.0/flags/mod.ts"
import * as z from "https://deno.land/x/zod@v3.21.4/mod.ts"
import { Configuration, OpenAIApi } from "npm:openai"

import { getStdin, jsonBlock, mdTable } from "./utils/mod.ts"

const args = flags.parse(Deno.args, {
  boolean: ["help", "reply", "show"],
  alias: { h: "help", r: "reply", s: "show" },
})

if (args.help) { // print help and exit
  console.log(`
# Usage

ai [options] MESSAGE

# Options
`.trim())
  console.log()
  console.log(mdTable(["Flag", "Effect"], [
    ["None", "Start a new conversation"],
    ["-r, --reply", "Continue existing chat"],
    ["-s, --show", "Show chat so far"],
  ]))
  Deno.exit()
}

const Message = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
})

const HISTORY_KEY = "history"

const history = (function getHistory() {
  const contents = localStorage.getItem(HISTORY_KEY)
  if (!contents) return null
  return z.array(Message).parse(JSON.parse(contents))
})()

if (args.show) { // print conversation so far and exit
  if (history && history.length > 1) {
    for (const msg of history.slice(1)) { // skip system prompt
      console.log(`# ${msg.role}\n\n${msg.content}\n`)
    }
  } else {
    console.log("no history found")
  }
  Deno.exit()
}

const Env = z.object({ OPENAI_API_KEY: z.string().min(1) })
const envPath = new URL(import.meta.resolve("./.env")).pathname
const env = Env.parse(await loadEnv({ envPath }))
const openai = new OpenAIApi(new Configuration({ apiKey: env.OPENAI_API_KEY }))

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

const messages = args.reply && history ? [...history, userMsg] : [systemMsg, userMsg]

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
