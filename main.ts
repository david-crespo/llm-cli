#! /usr/bin/env -S deno run --allow-env --allow-read --allow-net --allow-run=gh,glow

import { parseArgs } from "https://deno.land/std@0.220.1/cli/parse_args.ts"
import { readAll } from "https://deno.land/std@0.220.1/io/read_all.ts"
import OpenAI from "npm:openai@4.45.0"
import Anthropic from "npm:@anthropic-ai/sdk@0.24.0"
import { GoogleGenerativeAI } from "npm:@google/generative-ai@0.11.1"
import $ from "jsr:@david/dax@0.41.0"

const HELP = `
# Usage

\`\`\`
ai [OPTIONS] [MESSAGE]
ai <COMMAND> [ARGS...]
\`\`\`

Input from either MESSAGE or stdin is required unless using a 
command. If both are present, stdin will be appended to MESSAGE.

By default, this script will attempt to render output with glow,
but if glow is not present or output is being piped, it will print
the raw output to stdout.

# Options

\`\`\`
-r, --reply            Continue existing chat
-m, --model <str>      Select model by substring, e.g., 'opus'
-p, --persona <str>    Override persona in system prompt
--system <str>         Override system prompt (ignore persona)
\`\`\`

# Commands

\`\`\`
show [N or "all"]      Show chat so far (last N, default 1)
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
  timeMs: number
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

/**
 * The order of this list matters: preferred models go first.
 *
 * We pick a model by finding the first one containing the specified string.
 * But the same string can be in multiple model names. For example, "mini" is
 * in both gpt-4o-mini and the gemini models. By putting gpt-4o-mini earlier, we
 * ensure "mini" matches that. By putting gpt-4o first, we ensure "4o" matches
 * that.
 */
const allModels = [
  "gpt-4o-2024-08-06",
  "gpt-4o-mini",
  "claude-3-5-sonnet-20240620",
  "claude-3-opus-20240229",
  "claude-3-haiku-20240307",
  "gemini-1.5-pro-exp-0801",
  "gemini-1.5-pro-latest",
  "gemini-1.5-flash-latest",
] as const

type Model = typeof allModels[number]
const defaultModel: Model = "gpt-4o-2024-08-06"

const M = 1_000_000

// these are per token to keep it simple
const prices: Record<Model, { input: number; output: number }> = {
  "claude-3-opus-20240229": { input: 15 / M, output: 75 / M },
  "claude-3-5-sonnet-20240620": { input: 3 / M, output: 15 / M },
  "claude-3-haiku-20240307": { input: .25 / M, output: 1.25 / M },
  "gpt-4o-2024-08-06": { input: 2.5 / M, output: 10 / M },
  "gpt-4o-mini": { input: .15 / M, output: .6 / M },
  "gemini-1.5-pro-exp-0801": { input: 3.5 / M, output: 10.5 / M },
  "gemini-1.5-pro-latest": { input: 3.5 / M, output: 10.5 / M },
  "gemini-1.5-flash-latest": { input: .075 / M, output: .3 / M },
}

function getCost(model: Model, input_tokens: number, output_tokens: number) {
  const { input, output } = prices[model]
  const cost = (input * input_tokens) + (output * output_tokens)

  // Gemini models have double pricing over 128k https://ai.google.dev/pricing
  if (model.includes("gemini") && input_tokens > 128_000) return 2 * cost

  return cost
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
    max_tokens: 4096,
  })
  const respMsg = response.content[0]
  return {
    // we're not doing tool use yet, so the response will always be text
    content: respMsg.type === "text" ? respMsg.text : JSON.stringify(respMsg),
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    stop_reason: response.stop_reason!, // always non-null in non-streaming mode
  }
}

const geminiCreateMessage: CreateMessage = async (chat, input, model) => {
  const key = Deno.env.get("GEMINI_API_KEY")
  if (!key) throw Error("GEMINI_API_KEY missing")
  const result = await new GoogleGenerativeAI(key).getGenerativeModel({
    model,
    systemInstruction: chat.systemPrompt,
  }).startChat({
    history: chat.messages.map((msg) => ({
      // gemini uses model instead of assistant
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    })),
  }).sendMessage(input)

  return {
    content: result.response.text(),
    input_tokens: result.response.usageMetadata!.promptTokenCount,
    output_tokens: result.response.usageMetadata!.candidatesTokenCount,
    stop_reason: result.response.candidates?.[0].finishReason || "",
  }
}

// --------------------------------
// Utilities
// --------------------------------

const getStdin = async () => new TextDecoder().decode(await readAll(Deno.stdin)).trim()

const RENDERER = "glow"

async function renderMd(md: string) {
  if ($.commandExistsSync(RENDERER) && Deno.stdout.isTerminal()) {
    await $`${RENDERER}`.stdinText(md)
  } else {
    console.log(md)
  }
}

// returning never tells the calling code that this function exits
async function printHelp() {
  await renderMd(HELP + "\n" + modelsMd)
}

async function printError(msg: string) {
  await renderMd(`⚠️  ${msg}`)
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

// split from message content because we only want this in show or gist mode
function messageHeaderMd(msg: ChatMessage, msgNum: number, msgCount: number) {
  return `# ${msg.role} (${msgNum}/${msgCount})\n\n`
}

const timeFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

function messageContentMd(msg: ChatMessage) {
  let output = ""

  if (msg.role === "assistant") {
    // only show stop reason if it's not a natural stop
    const showStopReason = !["stop", "end_turn"].includes(msg.stop_reason.toLowerCase())

    output += `\`${msg.model}\``
    output += ` | ${timeFmt.format(msg.timeMs / 1000)} s`
    output += ` | ${moneyFmt.format(msg.cost)}`
    output += ` | **Tokens:** ${msg.input_tokens} -> ${msg.output_tokens}`
    if (showStopReason) output += ` | **Stop reason:** ${msg.stop_reason}`

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
      output += messageHeaderMd(msg, i + 1, msgCount)
      output += messageContentMd(msg)
    }
  })
  return output
}

// --------------------------------
// Key functionality
// --------------------------------

async function uploadGist(title: string, history: Chat) {
  if (!$.commandExistsSync("gh")) {
    await printError("Creating a gist requires the `gh` CLI (https://cli.github.com/)")
    Deno.exit(1)
  }
  const md = chatToMd(history)
  const filename = title ? `LLM chat - ${title}.md` : "LLM chat.md"
  await $`echo ${md} | gh gist create -f ${filename}`
}

/** Errors and exits if it can't resolve to a model */
async function resolveModel(modelArg: string | undefined): Promise<Model> {
  if (modelArg === undefined) return defaultModel
  if (modelArg.trim() === "") {
    await printError(`\`-m/--model\` flag requires an argument\n\n${modelsMd}`)
    Deno.exit(1)
  }

  // Find the first model containing the arg as a substring. See comment at
  // allModels definition about ordering.
  const match = allModels.find((m) => m.includes(modelArg.toLowerCase()))

  if (!match) {
    await printError(`'${modelArg}' isn't a substring of any model name.\n\n${modelsMd}`)
    Deno.exit(1)
  }

  return match
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
    if (arg === "all") return { cmd: "show", n: undefined }

    if (typeof arg === "undefined" || typeof arg === "number") {
      return { cmd: "show", n: arg || 1 } // default with no arg is 1
    }
    // otherwise this is just a message that starts with "show"
  }

  // otherwise, assume it's all one big chat message
  return { cmd: "message", content: posArgs.join(" ") }
}

// --------------------------------
// Actually do the thing
// --------------------------------

const args = parseArgs(Deno.args, {
  boolean: ["help", "reply"],
  string: ["persona", "model", "system"],
  alias: { h: "help", m: "model", p: "persona", r: "reply" },
})

if (args.help) {
  await printHelp()
  Deno.exit()
}

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
  if (!prevChat) {
    await printError("No chat in progress")
    Deno.exit(1)
  }
  await renderMd(chatToMd(prevChat, cmd.n))
  Deno.exit()
}

// TODO: gist should take a number arg like show
if (cmd.cmd === "gist") {
  if (!prevChat) {
    await printError("No chat in progress")
    Deno.exit(1)
  }
  const title = args._.slice(1).join(" ")
  await uploadGist(title, prevChat)
  Deno.exit()
}

// -r uses same model as last response if there is one and no model is specified
const prevModel = prevChat?.messages.findLast(isAssistant)?.model
const model = args.reply && prevModel && !args.model
  ? prevModel
  : await resolveModel(args.model)

const stdin = Deno.stdin.isTerminal() ? null : await getStdin()
if (!cmd.content && !stdin) {
  await printHelp()
  Deno.exit()
}
const input = [stdin, cmd.content].filter(Boolean).join("\n\n")

const persona = args.persona ? `You are ${args.persona}. ` : ""

const systemBase =
  "Your answers are precise. Answer only the question as asked. If the answer is a simple yes or no, include a little explanation if it would be helpful. When asked for code, only output code: do not explain unless asked to. Your answers must be in markdown format."

const systemPrompt = args.system || (persona + systemBase)

// if replying, use history as current chat, otherwise start new.
const chat: Chat = args.reply && prevChat ? prevChat : {
  createdAt: new Date().toLocaleString(),
  systemPrompt,
  messages: [],
}

const createMessage = model.startsWith("claude")
  ? claudeCreateMessage
  : model.startsWith("gemini")
  ? geminiCreateMessage
  : gptCreateMessage

const pb = $.progress("Thinking...")
try {
  const startTime = performance.now()
  const response = await createMessage(chat, input, model)
  pb.finish()
  const timeMs = performance.now() - startTime
  const assistantMsg = {
    role: "assistant" as const,
    model,
    ...response,
    cost: getCost(model, response.input_tokens, response.output_tokens),
    timeMs,
  }
  chat.messages.push({ role: "user", content: input }, assistantMsg)
  History.write(chat)
  await renderMd(messageContentMd(assistantMsg))
} catch (e) {
  pb.finish() // otherwise it hangs around
  if (e.response?.status) console.log("Request error:", e.response.status)
  if (e.response?.data) console.log(jsonBlock(e.response.data))
  if (e.response?.error) console.log(jsonBlock(e.response.error))
  if (!("response" in e)) console.log(codeBlock(e))
}
