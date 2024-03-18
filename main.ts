#! /usr/bin/env -S deno run --allow-env --allow-read --allow-net --allow-run=gh

import { dirname, fromFileUrl, join } from "https://deno.land/std@0.220.1/path/mod.ts"
import { parseArgs } from "https://deno.land/std@0.220.1/cli/parse_args.ts"
import { readAll } from "https://deno.land/std@0.220.1/io/read_all.ts"
import OpenAI from "https://deno.land/x/openai@v4.29.1/mod.ts"
import { loadSync as loadEnv } from "https://deno.land/std@0.220.1/dotenv/mod.ts"
import Anthropic from "npm:@anthropic-ai/sdk@0.18.0"
import $ from "https://deno.land/x/dax@0.39.2/mod.ts"

const HELP = `
# Usage

\`\`\`
ai [options] INPUT
\`\`\`

INPUT is required. Pass '-' as INPUT to read from stdin.

\`\`\`
-a, --append            Read from stdin and append to INPUT
-g, --gist [title]      Save chat to GitHub Gist with gh CLI
-m, --model <str>       Select model by substring, e.g., 'opus'
-p, --persona <str>     Override persona in system prompt
-r, --reply             Continue existing chat
-s, --show              Show chat so far
--system                Override system prompt (ignore persona)
--clear                 Delete current chat from localStorage
\`\`\`
`

// --------------------------------
// Core data model
// --------------------------------

type AssistantMessage = { role: "assistant"; model: string; content: string }
type UserMessage = { role: "user"; content: string }
type ChatMessage = UserMessage | AssistantMessage

const isAssistant = (m: ChatMessage): m is AssistantMessage => m.role === "assistant"

type Chat = {
  // For now we don't allow system prompt to be changed in the middle
  // of a chat. Otherwise we'd have to annotate each message with it.
  systemPrompt: string | undefined
  messages: ChatMessage[]
  createdAt: string
}

const HISTORY_KEY = "llm-cli"
const History = {
  read(): Chat | null {
    const contents = localStorage.getItem(HISTORY_KEY)
    if (!contents) return null
    return JSON.parse(contents)
  },
  write(chat: Chat) {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(chat))
  },
  clear() {
    localStorage.removeItem(HISTORY_KEY)
  },
}

const allModels = [
  "claude-3-opus-20240229",
  "claude-3-sonnet-20240229",
  "claude-3-haiku-20240307",
  "gpt-4-turbo-preview",
  "gpt-3.5-turbo",
]
const defaultModel = allModels[0]

// --------------------------------
// API Adapters
// --------------------------------

type CreateMessage = (
  chat: Chat,
  input: string,
  model: string,
) => Promise<AssistantMessage>

const gptCreateMessage: CreateMessage = async (chat, input, model) => {
  const systemMsg = chat.systemPrompt
    ? [{ role: "system" as const, content: chat.systemPrompt }]
    : []
  const messages = [
    ...systemMsg,
    ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: input },
  ]
  const resp = await new OpenAI().chat.completions.create({ model, messages })
  const content = resp.choices[0].message?.content
  if (!content) throw new Error("No response found")
  return { role: "assistant", model, content }
}

const claudeCreateMessage: CreateMessage = async (chat, input, model) => {
  const response = await new Anthropic().messages.create({
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
// Utilities
// --------------------------------

const getStdin = async () => new TextDecoder().decode(await readAll(Deno.stdin)).trim()

// returning never tells the calling code that this function exits
function printHelpAndExit(): never {
  console.log(HELP + "\n" + modelsMd)
  Deno.exit()
}

function exitWithError(msg: string): never {
  console.log(`⚠️  ${msg}`)
  Deno.exit(1)
}

const codeBlock = (contents: string, lang = "") => `\`\`\`${lang}\n${contents}\n\`\`\`\n`
const jsonBlock = (obj: unknown) => codeBlock(JSON.stringify(obj, null, 2), "json")

const modelBullet = (m: string) => `* ${m} ${m === defaultModel ? "(default)" : ""}`
const modelsMd = "# Models\n\n" + allModels.map(modelBullet).join("\n")

function chatToMd(chat: Chat): string {
  let output = `**Chat started:** ${chat.createdAt}\n\n`
  output += `**System prompt:** ${chat.systemPrompt}\n\n`
  for (const msg of chat.messages) { // skip system prompt
    const model = msg.role === "assistant" ? ` (${msg.model})` : ""
    output += `# ${msg.role}${model}\n\n`
    output += `${msg.content}\n\n`
  }
  return output
}

// --------------------------------
// Key functionality
// --------------------------------

async function uploadGist(gistArg: string, history: Chat) {
  if (!$.commandExistsSync("gh")) {
    exitWithError("Creating a gist requires the `gh` CLI (https://cli.github.com/)")
  }
  const md = chatToMd(history)
  const filename = gistArg ? `LLM chat - ${gistArg}.md` : "LLM chat.md"
  await $`echo ${md} | gh gist create -f ${filename}`
}

/** Errors and exits if it doesn't resolve to one model */
function resolveModel(modelArg: string | undefined): string {
  if (modelArg === undefined) return defaultModel
  if (modelArg.trim() === "") {
    exitWithError(`\`-m/--model\` flag requires an argument\n\n${modelsMd}`)
  }

  const matches = allModels.filter((m) => m.includes(modelArg.toLowerCase()))
  if (matches.length === 1) return matches[0]

  const error = matches.length === 0
    ? `'${modelArg}' isn't a substring of any model name.`
    : `'${modelArg}' is a substring of more than one model name.`
  exitWithError(`${error}\n\n${modelsMd}`)
}

// --------------------------------
// Actually do the thing
// --------------------------------

// Load .env file sitting next to script. This rigmarole is necessary because
// the default behavior of dotenv is to look for .env in the current working
// directory the script is being run from. Don't error if file doesn't exist
// because you can also set the env vars any old way and it'll just work.
const envPath = join(fromFileUrl(dirname(import.meta.url)), ".env")
loadEnv({ envPath, export: true })

const args = parseArgs(Deno.args, {
  boolean: ["help", "reply", "show", "append", "clear"],
  string: ["persona", "model", "gist", "system"],
  alias: {
    a: "append",
    g: "gist",
    h: "help",
    m: "model",
    p: "persona",
    r: "reply",
    s: "show",
  },
})

if (args.help) printHelpAndExit()

if (args.clear) {
  History.clear()
  console.log("Deleted chat from localStorage")
  Deno.exit()
}

const prevChat = History.read()

if (args.show) {
  if (!prevChat) exitWithError("No chat in progress")
  console.log(chatToMd(prevChat))
  Deno.exit()
}

// check against undefined because -g with no arg gives empty string,
// and we still want to upload the gist in that case
if (args.gist !== undefined) {
  if (!prevChat) exitWithError("No chat in progress")
  uploadGist(args.gist, prevChat)
  Deno.exit()
}

// -r uses same model as last response if there is one and no model is specified
const prevModel = prevChat?.messages.findLast(isAssistant)?.model
const model = args.reply && prevModel && !args.model ? prevModel : resolveModel(args.model)

const directInput = args._.join(" ")
if (!directInput) printHelpAndExit()

// in append mode, take direct input and a piped document and jam them together
const input = args.append
  ? directInput + "\n\n" + (await getStdin())
  : (directInput === "-" ? await getStdin() : directInput.toString())

const persona = args.persona || "experienced software engineer"

const systemPrompt = args.system ||
  `You are a ${persona}. Your answers are precise and avoid filler. Answer only the question as asked. Your answers should be in markdown format.`

// if replying, use history as current chat, otherwise start new.
const chat: Chat = args.reply && prevChat ? prevChat : {
  createdAt: new Date().toLocaleString(),
  systemPrompt,
  messages: [],
}

const createMessage = model.startsWith("claude") ? claudeCreateMessage : gptCreateMessage

try {
  const assistantMsg = await createMessage(chat, input, model)
  chat.messages.push({ role: "user", content: input }, assistantMsg)
  History.write(chat)
  console.log(`# assistant (${model})\n\n${assistantMsg.content}`)
} catch (e) {
  if (e.response?.status) console.log("Request error:", e.response.status)
  if (e.response?.data) console.log(jsonBlock(e.response.data))
  if (e.response?.error) console.log(jsonBlock(e.response.error))
  if (!("response" in e)) console.log(codeBlock(e))
}
