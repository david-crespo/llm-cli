#! /usr/bin/env -S deno run --allow-env --allow-read --allow-net
import { load as loadEnv } from "https://deno.land/std@0.184.0/dotenv/mod.ts"
import * as flags from "https://deno.land/std@0.184.0/flags/mod.ts"
import { readAll } from "https://deno.land/std@0.184.0/streams/read_all.ts"
import { type JSONValue } from "https://deno.land/std@0.184.0/jsonc/mod.ts"
import {
  type ChatCompletionResponseMessage as Message,
  Configuration,
  OpenAIApi,
} from "npm:openai@^3.3.0"

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
| -p, --persona [str] | Override default persona in system prompt |
| -t, --turbo | Use gpt-3.5-turbo instead of gpt-4 |
`

const History = {
  read() {
    const contents = localStorage.getItem("history")
    if (!contents) return null
    return JSON.parse(contents)
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

const getStdin = async () => new TextDecoder().decode(await readAll(Deno.stdin)).trim()

async function getOpenAI() {
  const envPath = new URL(import.meta.resolve("./.env")).pathname
  const env = await loadEnv({ envPath })
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not found in .env")
  return new OpenAIApi(new Configuration({ apiKey: env.OPENAI_API_KEY }))
}

// === script starts here ===

const args = flags.parse(Deno.args, {
  boolean: ["help", "reply", "show", "append", "turbo"],
  string: ["persona"],
  alias: { h: "help", r: "reply", s: "show", a: "append", p: "persona", t: "turbo" },
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

const persona = args.persona ||
  "experienced software engineer speaking to an experienced software engineer"

const systemMsg = {
  role: "system",
  content: `You are a ${persona}. Your answers are precise and avoid jargon and filler.
    Answer only the question as asked. Your answers should be in markdown format.`,
} as const

const messages: Message[] = args.reply && history || [systemMsg]

// in append mode, take direct input and a piped document and jam them together
const input = args.append
  ? directInput + "\n\n" + (await getStdin())
  : (directInput === "-" ? await getStdin() : directInput.toString())

messages.push({ role: "user", content: input })

const openai = await getOpenAI()

try {
  const model = args.turbo ? "gpt-3.5-turbo" : "gpt-4"
  const resp = await openai.createChatCompletion({ model, messages })
  const respMsg = resp.data.choices[0].message
  if (respMsg) {
    History.write([...messages, respMsg])
    console.log(respMsg.content)
  }
} catch (e) {
  if (e.response?.status) console.log("Request error:", e.response.status)
  if (e.response?.data) console.log(jsonBlock(e.response.data))
  if (!("response" in e)) console.log(e)
}
