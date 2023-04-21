#! /usr/bin/env -S deno run --allow-env --allow-read --allow-net
import { load as loadEnv } from "https://deno.land/std@0.184.0/dotenv/mod.ts"
import * as flags from "https://deno.land/std@0.184.0/flags/mod.ts"
import { readAll } from "https://deno.land/std@0.184.0/streams/read_all.ts"
import { type JSONValue } from "https://deno.land/std@0.184.0/jsonc/mod.ts"
import * as z from "https://deno.land/x/zod@v3.21.4/mod.ts"
import { Configuration, OpenAIApi } from "npm:openai"

// SETUP: put OPENAI_API_KEY in a .env file in the same directory as this script

// This program outputs Markdown, so to make it look really good, pipe it
// through something like Glow

const codeBlock = (contents: string, lang = "") => `\`\`\`${lang}\n${contents}\n\`\`\`\n`
const jsonBlock = (obj: JSONValue) => codeBlock(JSON.stringify(obj, null, 2), "json")

const HELP = `
# Usage

ai [options] MESSAGE 

# Options

Pass \`-\` as message to read from stdin.

| Flag | Effect |
| --- | --- |
| None | Start a new chat |
| -r, --reply | Continue existing chat |
| -s, --show | Show chat so far |
| -a, --append | Read from stdin and append to MESSAGE |
`

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

/** Read from `Deno.args[i]`, but `-` makes it readAll from stdin */
export async function getStdin() {
  return new TextDecoder().decode(await readAll(Deno.stdin)).trim()
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
    You are an experienced software developer.
    Your answers are precise and avoid jargon and filler.
    Answer only the question as asked. Do not give extra background.
    Go right into the answer. Your answers should be in markdown format.
  `.trim(),
} as const

const docPrelude = "\n\nAnswer with reference to this document:\n\n"

// === script starts here ===

const args = flags.parse(Deno.args, {
  boolean: ["help", "reply", "show", "append"],
  alias: { h: "help", r: "reply", s: "show", a: "append" },
})

if (args.help) {
  console.log(HELP)
  Deno.exit()
}

const history = History.read()

if (args.show) {
  printChat(history)
  Deno.exit()
}

const directInput = args._[0]
if (!directInput) {
  console.log(HELP)
  Deno.exit()
}

const messages: Message[] = args.reply && history || [systemMsg]

// in append mode, take direct input and a piped document and jam them together
const input = args.append
  ? directInput + docPrelude + (await getStdin())
  : (directInput === "-" ? await getStdin() : directInput.toString())

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
