#! /usr/bin/env -S deno run --allow-env --allow-read --allow-net --allow-write
import { load as loadEnv } from "https://deno.land/std@0.184.0/dotenv/mod.ts"
import * as flags from "https://deno.land/std@0.184.0/flags/mod.ts"
import * as z from "https://deno.land/x/zod@v3.21.4/mod.ts"
import { Configuration, OpenAIApi } from "npm:openai"

import { getStdin, jsonBlock, mdTable } from "./utils/mod.ts"

function printHelp() {
  console.log(`
# Usage

ai [options] MESSAGE 

# Options

Pass \`-\` as message to read from stdin.

`.trim())
  console.log()
  console.log(mdTable(["Flag", "Effect"], [
    ["None", "Start a new conversation"],
    ["-r, --reply", "Continue existing chat"],
    ["-s, --show", "Show chat so far"],
  ]))
}

const Message = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
})

type Message = z.infer<typeof Message>

const History = {
  read() {
    const contents = localStorage.getItem("history")
    if (!contents) return null
    return z.array(Message).parse(JSON.parse(contents))
  },
  write(messages: Message[]) {
    localStorage.setItem("history", JSON.stringify(messages))
  },
}

function printChat(messages: Message[] | null) {
  if (!messages || messages.length <= 1) {
    console.log("no history found")
    return
  }

  for (const msg of messages.slice(1)) { // skip system prompt
    console.log(`# ${msg.role}\n\n${msg.content}\n`)
  }
}

async function getOpenAI() {
  const Env = z.object({ OPENAI_API_KEY: z.string().min(1) })
  const envPath = new URL(import.meta.resolve("./.env")).pathname
  const env = Env.parse(await loadEnv({ envPath }))
  return new OpenAIApi(new Configuration({ apiKey: env.OPENAI_API_KEY }))
}

// TODO: Add an argument that selects from a set of system messages
const systemMsg = {
  role: "system",
  content: `
    You are an experienced software developer with a philosophical style.
    Your answers are precise, concise, and avoid jargon and filler.
    Answer only the question as asked. Do not give extra background.
    Go right into the answer. Your answers should be in markdown format.
  `.trim(),
} as const

// === script starts here ===

const args = flags.parse(Deno.args, {
  boolean: ["help", "reply", "show"],
  alias: { h: "help", r: "reply", s: "show" },
})

if (args.help) {
  printHelp()
  Deno.exit()
}

const history = History.read()

if (args.show) {
  printChat(history)
  Deno.exit()
}

const directInput = args._[0]
if (!directInput) {
  printHelp()
  Deno.exit()
}

const messages: Message[] = args.reply && history || [systemMsg]

const input = directInput === "-" ? await getStdin() : directInput.toString()
messages.push({ role: "user", content: input })

const openai = await getOpenAI()

try {
  const resp = await openai.createChatCompletion({ model: "gpt-4", messages })
  const respMsg = resp.data.choices[0].message
  if (respMsg) {
    History.write([...messages, respMsg])
    console.log(respMsg.content)
  }
} catch (e) {
  console.log("Request error:", e.response.status)
  console.log(jsonBlock(e.response.data))
}
