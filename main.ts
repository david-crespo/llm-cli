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
ai [OPTIONS] [MESSAGE]
ai <COMMAND> [ARGS...]
\`\`\`

Input from either MESSAGE or stdin is required unless using a 
command. If both are present, stdin will be appended to MESSAGE.

# Options

\`\`\`
-r, --reply            Continue existing chat
-m, --model <str>      Select model by substring, e.g., 'opus'
-p, --persona <str>    Override persona in system prompt
--system <str>         Override system prompt (ignore persona)
\`\`\`

# Commands

\`\`\`
show [N]               Show chat so far (last N messages, or all)
gist [title]           Save chat to GitHub Gist with gh CLI
clear                  Delete current chat from localStorage
\`\`\`

# Examples

\`\`\`sh
ai 'What is the capital of France?'
cat main.ts | ai 'what is this?'
echo 'what are you?' | ai
ai -r 'elaborate on that'
ai -m gpt-4 'What are generic types?'
ai gist 'Generic types'
\`\`\`
`

// --------------------------------
// Core data model
// --------------------------------

type AssistantMessage = {
  role: "assistant"
  model: Model
  content: string
  input_tokens: number
  output_tokens: number
  stop_reason: string
  cost: number
}
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
  "gpt-4-turbo",
] as const
const defaultModel = "gpt-4-turbo"

type Model = typeof allModels[number]

// these are per token to keep it simple
const prices: Record<Model, { input: number; output: number }> = {
  "claude-3-opus-20240229": { input: .015 / 1000, output: .075 / 1000 },
  "claude-3-sonnet-20240229": { input: 0.003 / 1000, output: .015 / 1000 },
  "claude-3-haiku-20240307": { input: .00025 / 1000, output: .00125 / 1000 },
  "gpt-4-turbo": { input: .01 / 1000, output: .03 / 1000 },
}

function getCost(model: Model, input_tokens: number, output_tokens: number) {
  const { input, output } = prices[model]
  return (input * input_tokens) + (output * output_tokens)
}

// --------------------------------
// API Adapters
// --------------------------------

type ModelResponse = {
  content: string
  input_tokens: number
  output_tokens: number
  stop_reason: string
}

type CreateMessage = (
  chat: Chat,
  input: string,
  model: string,
) => Promise<ModelResponse>

const gptCreateMessage: CreateMessage = async (chat, input, model) => {
  const systemMsg = chat.systemPrompt
    ? [{ role: "system" as const, content: chat.systemPrompt }]
    : []
  const messages = [
    ...systemMsg,
    ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: input },
  ]
  const response = await new OpenAI().chat.completions.create({ model, messages })
  const content = response.choices[0].message?.content
  if (!content) throw new Error("No response found")
  return {
    content,
    input_tokens: response.usage?.prompt_tokens || 0,
    output_tokens: response.usage?.completion_tokens || 0,
    stop_reason: response.choices[0].finish_reason,
  }
}

const claudeCreateMessage: CreateMessage = async (chat, input, model) => {
  const response = await new Anthropic().messages.create({
    model,
    system: chat.systemPrompt,
    messages: [
      ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: input },
    ],
    max_tokens: 2048,
  })
  return {
    content: response.content[0].text,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    stop_reason: response.stop_reason!, // always non-null in non-streaming mode
  }
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

const modelBullet = (m: string) => `* ${m} ${m === defaultModel ? "(⭐ default)" : ""}`
const modelsMd = "# Models\n\n" + allModels.map(modelBullet).join("\n")

const moneyFmt = Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 5,
})

function messageToMd(msg: ChatMessage, msgNum: number, msgCount: number) {
  let output = `# ${msg.role} (${msgNum}/${msgCount})`
  output += "\n\n"

  if (msg.role === "assistant") {
    output += "`" + msg.model + "`"
    output += ` | **Cost:** ${moneyFmt.format(msg.cost)}`
    output += ` | **Tokens:** ${msg.input_tokens} -> ${msg.output_tokens}`
    if (["max_tokens", "length"].includes(msg.stop_reason)) {
      output += ` | **Stop reason:** ${msg.stop_reason}`
    }
    output += "\n\n"
  }

  output += `${msg.content}\n\n`
  return output
}

function chatToMd(chat: Chat, lastN: number = 0): string {
  let output = `**Chat started:** ${chat.createdAt}\n\n`
  output += `**System prompt:** ${chat.systemPrompt}\n\n`
  const msgCount = chat.messages.length
  chat.messages.forEach((msg, i) => {
    if (!lastN || i >= msgCount - lastN) {
      output += messageToMd(msg, i + 1, msgCount)
    }
  })
  return output
}

// --------------------------------
// Key functionality
// --------------------------------

async function uploadGist(title: string, history: Chat) {
  if (!$.commandExistsSync("gh")) {
    exitWithError("Creating a gist requires the `gh` CLI (https://cli.github.com/)")
  }
  const md = chatToMd(history)
  const filename = title ? `LLM chat - ${title}.md` : "LLM chat.md"
  await $`echo ${md} | gh gist create -f ${filename}`
}

/** Errors and exits if it doesn't resolve to one model */
function resolveModel(modelArg: string | undefined): Model {
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
// CLI structure
// --------------------------------

type Command =
  | { cmd: "clear" }
  | { cmd: "show"; n: number | undefined }
  | { cmd: "gist"; title: string | undefined }
  | { cmd: "message"; content: string }

function parseCmd(posArgs: (string | number)[]): Command {
  const [cmd, ...rest] = posArgs

  if (cmd == "clear" && rest.length === 0) {
    return { cmd: "clear" }
  } else if (cmd === "gist") {
    // a message would never start with gist
    return { cmd: "gist", title: rest.join(" ") || undefined }
  } else if (cmd === "show" && rest.length <= 1) {
    const arg = rest.at(0)
    if (typeof arg === "undefined" || typeof arg === "number") {
      return { cmd: "show", n: arg }
    }
    // otherwise this is just a message that starts with "show"
  }

  // otherwise, assume it's all one big chat message
  return { cmd: "message", content: posArgs.join(" ") }
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
  boolean: ["help", "reply"],
  string: ["persona", "model", "system"],
  alias: { h: "help", m: "model", p: "persona", r: "reply" },
})

if (args.help) printHelpAndExit()

const cmd = parseCmd(args._)

if (cmd.cmd === "clear") {
  History.clear()
  console.log("Deleted chat from localStorage")
  Deno.exit()
}

const prevChat = History.read()

// check for no other args because a prompt could start with "show", and we
// still want to treat that as a prompt
if (cmd.cmd === "show") {
  if (!prevChat) exitWithError("No chat in progress")
  console.log(chatToMd(prevChat, cmd.n))
  Deno.exit()
}

// TODO: gist should take a number arg like show
if (cmd.cmd === "gist") {
  if (!prevChat) exitWithError("No chat in progress")
  const title = args._.slice(1).join(" ")
  await uploadGist(title, prevChat)
  Deno.exit()
}

// -r uses same model as last response if there is one and no model is specified
const prevModel = prevChat?.messages.findLast(isAssistant)?.model
const model = args.reply && prevModel && !args.model ? prevModel : resolveModel(args.model)

const stdin = Deno.stdin.isTerminal() ? null : await getStdin()
if (!cmd.content && !stdin) printHelpAndExit()
const input = [stdin, cmd.content].filter(Boolean).join("\n\n")

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
  const response = await createMessage(chat, input, model)
  const assistantMsg = {
    role: "assistant" as const,
    model,
    ...response,
    cost: getCost(model, response.input_tokens, response.output_tokens),
  }
  chat.messages.push({ role: "user", content: input }, assistantMsg)
  History.write(chat)
  const msgCount = chat.messages.length
  console.log(messageToMd(assistantMsg, msgCount, msgCount))
} catch (e) {
  if (e.response?.status) console.log("Request error:", e.response.status)
  if (e.response?.data) console.log(jsonBlock(e.response.data))
  if (e.response?.error) console.log(jsonBlock(e.response.error))
  if (!("response" in e)) console.log(codeBlock(e))
}
