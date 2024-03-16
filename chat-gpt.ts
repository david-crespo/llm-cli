#! /usr/bin/env -S deno run --allow-env --allow-read --allow-net
import * as flags from "https://deno.land/std@0.184.0/flags/mod.ts"
import { readAll } from "https://deno.land/std@0.184.0/streams/read_all.ts"
import { type JSONValue } from "https://deno.land/std@0.184.0/jsonc/mod.ts"
import OpenAI from "https://deno.land/x/openai@v4.16.1/mod.ts"

// considered annotating each response with the model that generated it, but
// let's first see if requiring them all to be the same model is tolerable

type Chat = {
  // For now we don't allow model or system prompt to be changed in the middle
  // of a chat. Otherwise we'd have to annotate each message with both.
  model: string
  systemPrompt: string | null
  messages: {
    role: "user" | "assistant"
    content: string
  }[]
  // making this a string means we don't have to think about parsing
  createdAt: string
}

// send message to the API and return the response
type CreateMessage = (chat: Chat, input: string, turbo: boolean) => Promise<string>

// --------------------------------

type GptMessage = {
  role: "user" | "assistant" | "system"
  content: string
}

const gptCreateMessage: CreateMessage = async function (chat, input, turbo) {
  const openai = new OpenAI()
  const model = turbo ? "gpt-3.5-turbo-1106" : "gpt-4-turbo-preview"
  const systemMsg = chat.systemPrompt
    ? [{ role: "system" as const, content: chat.systemPrompt }]
    : []
  const messages: GptMessage[] = [
    ...systemMsg,
    ...chat.messages,
    { role: "user", content: input },
  ]
  if (chat.systemPrompt) {
    messages.unshift({ role: "system" as const, content: chat.systemPrompt })
  }

  const resp = await openai.chat.completions.create({ model, messages })
  const respStr = resp.choices[0].message?.content
  if (!respStr) throw new Error("No response found")
  return respStr
}

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
  read(): Chat | null {
    const contents = localStorage.getItem("history2")
    if (!contents) return null
    return JSON.parse(contents)
  },
  write(chat: Chat) {
    localStorage.setItem("history2", JSON.stringify(chat))
  },
}

const getStdin = async () => new TextDecoder().decode(await readAll(Deno.stdin)).trim()

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
  if (history) {
    console.log(`**Model:** ${history.model}\n`)
    console.log(`**Chat started:** ${history.createdAt}\n`)
    console.log(`**System prompt:** ${history.systemPrompt}`)
    for (const msg of history.messages) { // skip system prompt
      console.log(`# ${msg.role}\n\n${msg.content}\n`)
    }
  } else {
    console.log("No history found")
  }
  Deno.exit()
}

const directInput = args._[0]
if (!directInput) {
  console.log(HELP)
  Deno.exit()
}

const persona = args.persona ||
  "experienced software engineer speaking to an experienced software engineer"

const systemPrompt =
  `You are a ${persona}. Your answers are precise and avoid filler. Answer only the question as asked. Your answers should be in markdown format.`

// if replying, use history as current chat, otherwise start new.
// if there is no history, ignore reply flag
const chat: Chat = args.reply && history ? history : {
  createdAt: new Date().toLocaleString(),
  model: args.turbo ? "gpt-3.5-turbo-1106" : "gpt-4-turbo-preview",
  systemPrompt,
  messages: [],
}

// in append mode, take direct input and a piped document and jam them together
const input = args.append
  ? directInput + "\n\n" + (await getStdin())
  : (directInput === "-" ? await getStdin() : directInput.toString())

try {
  const respMsg = await gptCreateMessage(chat, input, args.turbo)
  chat.messages.push({ role: "user", content: input })
  chat.messages.push({ role: "assistant", content: respMsg })
  History.write(chat)
  console.log(respMsg)
} catch (e) {
  if (e.response?.status) console.log("Request error:", e.response.status)
  if (e.response?.data) console.log(jsonBlock(e.response.data))
  if (!("response" in e)) console.log(e)
}
