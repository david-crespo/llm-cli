#! /usr/bin/env -S deno run --allow-env --allow-read --allow-net
import { parseArgs } from "https://deno.land/std@0.220.1/cli/parse_args.ts"
import { readAll } from "https://deno.land/std@0.184.0/streams/read_all.ts"
import { type JSONValue } from "https://deno.land/std@0.184.0/jsonc/mod.ts"
import OpenAI from "https://deno.land/x/openai@v4.29.1/mod.ts"
import "https://deno.land/std@0.219.0/dotenv/load.ts"
import Anthropic from "npm:@anthropic-ai/sdk@0.18.0"

// const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") })
// const anthropic = new Anthropic()
// console.log(anthropic.apiKey)
// Deno.exit()

// SETUP: put OPENAI_API_KEY in a .env file in the same directory as this script

// This program outputs Markdown, so to make it look really good, pipe it
// through something like Glow

// considered annotating each response with the model that generated it, but
// let's first see if requiring them all to be the same model is tolerable

type AssistantMessage = { role: "assistant"; model: string; content: string }
type UserMessage = { role: "user"; content: string }
type ChatMessage = UserMessage | AssistantMessage

const isAssistant = (m: ChatMessage): m is AssistantMessage => m.role === "assistant"

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
  model: string,
) => Promise<AssistantMessage>

// --------------------------------

const gptModels = ["gpt-4-turbo-preview", "gpt-3.5-turbo"]

const gptCreateMessage: CreateMessage = async (chat, input, model) => {
  const openai = new OpenAI()
  const systemMsg = chat.systemPrompt
    ? [{ role: "system" as const, content: chat.systemPrompt }]
    : []
  const messages = [
    ...systemMsg,
    ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: input },
  ]
  const resp = await openai.chat.completions.create({ model, messages })
  const content = resp.choices[0].message?.content
  if (!content) throw new Error("No response found")
  return { role: "assistant", model, content }
}

// --------------------------------

const claudeModels = [
  "claude-3-opus-20240229",
  "claude-3-sonnet-20240229",
  "claude-3-haiku-20240307",
]

const claudeCreateMessage: CreateMessage = async (chat, input, model) => {
  const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") })
  const response = await anthropic.messages.create({
    model,
    system: chat.systemPrompt,
    messages: [
      ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: input },
    ],
    max_tokens: 1024,
  })
  const content = response.content[0].text
  return { role: "assistant", model, content }
}

// --------------------------------

const allModels = [...claudeModels, ...gptModels]

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
| -a, --append | Read from stdin and append to MESSAGE |
| -m, --model [str] | Select model by substring, e.g., 'opus' |
| -p, --persona [str] | Override persona in system prompt |
| -r, --reply | Continue existing chat |
| -s, --show | Show chat so far |

# Models
${
  allModels
    .map((m, i) => `* ${m} ${i === 0 ? "(default)" : ""}`)
    .join("\n")
}
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

/** Errors and exits if it doesn't resolve to one model */
function resolveModel(modelArg: string | undefined): string {
  if (modelArg === undefined) return allModels[0] // default opus
  if (modelArg.trim() === "") {
    console.log("Error: -m/--model flag requires an argument.")
    console.log(HELP)
    Deno.exit()
  }

  const matches = allModels.filter((m) => m.includes(modelArg.toLowerCase()))
  if (matches.length === 1) return matches[0]

  const error = matches.length === 0
    ? `'${modelArg}' doesn't match any model.`
    : `'${modelArg}' matches more than one model.`
  const bullets = allModels
    .map((m, i) =>
      `* ${matches.includes(m) ? `**${m}**` : m} ${i === 0 ? "(default)" : ""}`
    )
    .join("\n")
  console.log(`${error}\n\n${bullets}`)
  Deno.exit()
}

// === script starts here ===

const args = parseArgs(Deno.args, {
  boolean: ["help", "reply", "show", "append"],
  string: ["persona", "model"],
  alias: {
    a: "append",
    h: "help",
    m: "model",
    p: "persona",
    r: "reply",
    s: "show",
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

// undefined if there is no history
const lastModel = history?.messages.findLast(isAssistant)?.model

// -r uses same model as last response if there is one and no model is specified
const model = args.reply && lastModel && args.model === undefined
  ? lastModel
  : resolveModel(args.model)

const directInput = args._[0]
if (!directInput) {
  console.log("Error: MESSAGE required. Pass '-' to read from stdin only.")
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

const createMessage = claudeModels.includes(model) ? claudeCreateMessage : gptCreateMessage

// in append mode, take direct input and a piped document and jam them together
const input = args.append
  ? directInput + "\n\n" + (await getStdin())
  : (directInput === "-" ? await getStdin() : directInput.toString())

try {
  const assistantMsg = await createMessage(chat, input, model)
  chat.messages.push({ role: "user", content: input })
  chat.messages.push(assistantMsg)
  History.write(chat)
  console.log(`# assistant (${model})`)
  console.log(assistantMsg.content)
} catch (e) {
  // TODO: update error handling for claude?
  if (e.response?.status) console.log("Request error:", e.response.status)
  if (e.response?.data) console.log(jsonBlock(e.response.data))
  if (e.response?.error) console.log(jsonBlock(e.response.error))
  if (!("response" in e)) console.log(codeBlock(e))
}
