#! /usr/bin/env -S deno run --allow-env --allow-read --allow-net
import * as flags from "https://deno.land/std@0.184.0/flags/mod.ts"
import { readAll } from "https://deno.land/std@0.184.0/streams/read_all.ts"
import { type JSONValue } from "https://deno.land/std@0.184.0/jsonc/mod.ts"
import OpenAI from "https://deno.land/x/openai@v4.16.1/mod.ts"
import "https://deno.land/std@0.219.0/dotenv/load.ts"
import Anthropic from "npm:@anthropic-ai/sdk@0.18.0"

// considered annotating each response with the model that generated it, but
// let's first see if requiring them all to be the same model is tolerable

type AssistantMessage = { role: "assistant"; model: string; content: string }
type UserMessage = { role: "user"; content: string }
type ChatMessage = UserMessage | AssistantMessage

type Chat = {
  // For now we don't allow system prompt to be changed in the middle
  // of a chat. Otherwise we'd have to annotate each message with it.
  systemPrompt: string | undefined
  messages: ChatMessage[]
  // making this a string means we don't have to think about parsing
  createdAt: string
}

// send message to the API and return the response
type CreateMessage = (
  chat: Chat,
  input: string,
  turbo: boolean,
) => Promise<AssistantMessage>

const msgsForApi = (
  messages: ChatMessage[],
  input: string,
) => [
  // need to take the model key out of AssistantMessage or OpenAI gets mad
  ...messages.map((m) => ({ role: m.role, content: m.content })),
  { role: "user" as const, content: input },
]

// --------------------------------

const gptCreateMessage: CreateMessage = async function (chat, input, turbo) {
  const openai = new OpenAI()
  const model = turbo ? "gpt-3.5-turbo-1106" : "gpt-4-turbo-preview"
  const systemMsg = chat.systemPrompt
    ? [{ role: "system" as const, content: chat.systemPrompt }]
    : []
  const messages = [...systemMsg, ...msgsForApi(chat.messages, input)]
  const resp = await openai.chat.completions.create({ model, messages })
  const content = resp.choices[0].message?.content
  if (!content) throw new Error("No response found")
  return { role: "assistant", model, content }
}

// --------------------------------

const claudeCreateMessage: CreateMessage = async function (chat, input, turbo) {
  const anthropic = new Anthropic({
    apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
  })

  const model = turbo ? "claude-3-sonnet-20240229" : "claude-3-opus-20240229"
  const response = await anthropic.messages.create({
    max_tokens: 1024,
    system: chat.systemPrompt,
    messages: msgsForApi(chat.messages, input),
    model,
  })
  const content = response.content[0].text
  return { role: "assistant", model, content }
}

// --------------------------------

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
| -c, --claude | Use Claude instead of GPT |
| -r, --reply | Continue existing chat |
| -s, --show | Show chat so far |
| -a, --append | Read from stdin and append to MESSAGE |
| -p, --persona [str] | Override default persona in system prompt |
| -t, --turbo | Use a faster, cheaper model |
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

function printChat(chat: Chat) {
  console.log(`**Chat started:** ${chat.createdAt}\n`)
  console.log(`**System prompt:** ${chat.systemPrompt}`)
  for (const msg of chat.messages) { // skip system prompt
    const model = msg.role === "assistant" ? ` (${msg.model})` : ""
    console.log(`# ${msg.role}${model}\n\n`)
    console.log(`${msg.content}\n`)
  }
}

const getStdin = async () => new TextDecoder().decode(await readAll(Deno.stdin)).trim()

// === script starts here ===

const args = flags.parse(Deno.args, {
  boolean: ["help", "claude", "reply", "show", "append", "turbo"],
  string: ["persona"],
  alias: {
    h: "help",
    c: "claude",
    r: "reply",
    s: "show",
    a: "append",
    p: "persona",
    t: "turbo",
  },
})

if (args.help) {
  console.log(HELP)
  Deno.exit()
}

const history = History.read()

if (args.show) {
  if (history) {
    printChat(history)
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
  systemPrompt,
  messages: [],
}

// in append mode, take direct input and a piped document and jam them together
const input = args.append
  ? directInput + "\n\n" + (await getStdin())
  : (directInput === "-" ? await getStdin() : directInput.toString())

const createMessage = args.claude ? claudeCreateMessage : gptCreateMessage

try {
  const assistantMsg = await createMessage(chat, input, args.turbo)
  chat.messages.push({ role: "user", content: input })
  chat.messages.push(assistantMsg)
  History.write(chat)
  console.log(assistantMsg.content)
} catch (e) {
  // TODO: update error handling for claude?
  if (e.response?.status) console.log("Request error:", e.response.status)
  if (e.response?.data) console.log(jsonBlock(e.response.data))
  if (!("response" in e)) console.log(e)
}
