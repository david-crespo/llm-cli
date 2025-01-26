#! /usr/bin/env -S deno run --allow-env --allow-read --allow-net --allow-run=gh,glow

import { parseArgs } from "jsr:@std/cli@1.0/parse-args"
import { readAll } from "jsr:@std/io@0.224"
import $ from "jsr:@david/dax@0.42"
import { markdownTable } from "https://esm.sh/markdown-table@3.0.4"

import OpenAI from "npm:openai@4.67"
import Anthropic from "npm:@anthropic-ai/sdk@0.28"
import { GoogleGenerativeAI, type ModelParams } from "npm:@google/generative-ai@0.21"
import * as R from "npm:remeda@2.19"

type Price = { input: number; output: number; input_cached?: number }

const M = 1_000_000
// keep the Price type for inferred values while keeping const keys
const makeModels = <T extends Record<string, Price>>(models: T): Record<keyof T, Price> =>
  models
/**
 * The order matters: preferred models go first.
 *
 * We pick a model by finding the first one containing the specified string.
 * But the same string can be in multiple model names. For example, "mini" is
 * in both gpt-4o-mini and the gemini models. By putting gpt-4o-mini earlier, we
 * ensure "mini" matches that. By putting gpt-4o first, we ensure "4o" matches
 * that.
 */
const models = makeModels({
  "claude-3-5-sonnet-latest": { input: 3 / M, output: 15 / M },
  "claude-3-5-haiku-latest": { input: 1 / M, output: 5 / M },
  "chatgpt-4o-latest": { input: 2.5 / M, input_cached: 1.25 / M, output: 10 / M },
  "gpt-4o-mini": { input: .15 / M, input_cached: 0.075 / M, output: .6 / M },
  "o1-mini": { input: 3 / M, input_cached: 1.5 / M, output: 12 / M },
  "o1-preview": { input: 15 / M, input_cached: 7.5 / M, output: 60 / M },
  "gemini-exp-1206": { input: 1.25 / M, output: 2.50 / M }, // >128k: 5 / 10
  "gemini-2.0-flash-exp": { input: .075 / M, output: .3 / M }, // >128k: 0.15 / 0.60
  "gemini-2.0-flash-thinking-exp": { input: .35 / M, output: 1.5 / M }, // estimated
  "groq-llama-3.3-70b-versatile": { input: .59 / M, output: 0.79 / M },
  // no price online so assume same as llama-70b for now
  "groq-deepseek-r1-distill-llama-70b": { input: .59 / M, output: 0.79 / M },
  "deepseek-chat": { input: 0.14 / M, input_cached: 0.014 / M, output: 0.28 / M },
  "deepseek-reasoner": { input: 0.55 / M, input_cached: 0.14 / M, output: 2.19 / M },
  // technically free until they set up their paid tier but whatever
  "cerebras-llama-3.3-70b": { input: 0.85 / M, output: 1.20 / M },
})

type Model = keyof typeof models
const defaultModel: Model = "claude-3-5-sonnet-latest"

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

| Option | Description |
|------|-------------|
| -r, --reply | Continue existing chat |
| -m, --model &lt;str&gt; | Select model by substring, e.g., \`opus\` |
| -p, --persona &lt;str&gt; | Override persona in system prompt |
| -t, --tool &lt;str&gt; | Use tools (\`code\` or \`search\`, Gemini only) |
| --system &lt;str&gt; | Override system prompt (ignore persona) |
| --raw | Print LLM text directly (no metadata) |

# Commands

| Command | Description |
| --- | --- |
| show [--all] [-n] | Show chat so far (last N, default 1) |
| gist [title] [-n] | Save chat to GitHub Gist with gh CLI |
| history | List recent chats (up to 20) |
| resume | Pick a chat to bump to current |
| clear | Delete current chat from localStorage |

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

type TokenCounts = {
  input: number
  input_cache_hit?: number
  output: number
}

type AssistantMessage = {
  role: "assistant"
  model: Model
  content: string
  tokens: TokenCounts
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
  summary?: string
}

const HISTORY_KEY = "llm-cli"
const Storage = {
  read(): Chat[] {
    const contents = localStorage.getItem(HISTORY_KEY)
    if (!contents) return []
    return JSON.parse(contents)
  },
  write(history: Chat[]) {
    // only save up to 20 most recent chats
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-20)))
  },
  clear() {
    localStorage.removeItem(HISTORY_KEY)
  },
}

function getCost(model: Model, tokens: TokenCounts) {
  const { input, output, input_cached } = models[model]

  // when there is caching and we have cache pricing, take it into account
  const cost = input_cached && tokens.input_cache_hit
    ? (input_cached * tokens.input_cache_hit) +
      (input * (tokens.input - tokens.input_cache_hit)) + (output * tokens.output)
    : (input * tokens.input) + (output * tokens.output)

  // Gemini models have double pricing over 128k https://ai.google.dev/pricing
  if (model.includes("gemini") && tokens.input > 128_000) return 2 * cost

  return cost
}

// --------------------------------
// API Adapters
// --------------------------------

type ModelResponse = {
  content: string
  tokens: TokenCounts
  stop_reason: string
}

type ChatInput = {
  chat: Chat
  input: string
  model: string
  tools: string[]
}

const makeOpenAIFunc = (client: OpenAI) => async ({ chat, input, model }: ChatInput) => {
  const systemMsg = chat.systemPrompt
    ? [{
      role: model.startsWith("o1") ? "user" as const : "system" as const,
      content: chat.systemPrompt,
    }]
    : []
  const messages = [
    ...systemMsg,
    ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: input },
  ]
  const response = await client.chat.completions.create({ model, messages })
  const content = response.choices[0].message?.content
  if (!content) throw new Error("No response found")
  return {
    content,
    tokens: {
      input: response.usage?.prompt_tokens || 0,
      output: response.usage?.completion_tokens || 0,
      input_cache_hit: response.usage?.prompt_tokens_details?.cached_tokens || 0,
    },
    stop_reason: response.choices[0].finish_reason,
  }
}

const gptCreateMessage = makeOpenAIFunc(new OpenAI())

const groqCreateMessage = makeOpenAIFunc(
  new OpenAI({
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: Deno.env.get("GROQ_API_KEY"),
  }),
)

const deepseekCreateMessage = makeOpenAIFunc(
  new OpenAI({
    baseURL: "https://api.deepseek.com",
    apiKey: Deno.env.get("DEEPSEEK_API_KEY"),
  }),
)

const cerebrasCreateMessage = makeOpenAIFunc(
  new OpenAI({
    baseURL: "https://api.cerebras.ai/v1",
    apiKey: Deno.env.get("CEREBRAS_API_KEY"),
  }),
)

async function claudeCreateMessage({ chat, input, model }: ChatInput) {
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
    tokens: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    },
    stop_reason: response.stop_reason!, // always non-null in non-streaming mode
  }
}

async function geminiCreateMessage({ chat, input, model, tools }: ChatInput) {
  const key = Deno.env.get("GEMINI_API_KEY")
  if (!key) throw Error("GEMINI_API_KEY missing")

  const params: ModelParams = { model }
  if (tools && tools.length > 0) {
    params.tools = []
    // @ts-expect-error googleSearch is real, the types are wrong
    if (tools.includes("search")) params.tools.push({ googleSearch: {} })
    if (tools.includes("code")) params.tools.push({ codeExecution: {} })
  } else {
    // code seems incompatible with a system prompt. search isn't, but it's too
    // concise with the system prompt, so we'll leave it off there too
    params.systemInstruction = chat.systemPrompt
  }

  const result = await new GoogleGenerativeAI(key).getGenerativeModel(params)
    .startChat({
      history: chat.messages.map((msg) => ({
        // gemini uses model instead of assistant
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      })),
    }).sendMessage(input)

  return {
    content: result.response.text(),
    tokens: {
      input: result.response.usageMetadata!.promptTokenCount,
      output: result.response.usageMetadata!.candidatesTokenCount,
    },
    stop_reason: result.response.candidates?.[0].finishReason || "",
  }
}

// --------------------------------
// Utilities
// --------------------------------

const getStdin = async () => new TextDecoder().decode(await readAll(Deno.stdin)).trim()

const RENDERER = "glow"

async function renderMd(md: string, raw = false) {
  if ($.commandExistsSync(RENDERER) && Deno.stdout.isTerminal() && !raw) {
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

const moneyFmt = Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 5,
})

const modelsTable = markdownTable([
  ["Model", "Input (+cached) in $/M", "Output in $/M"],
  ...Object.entries(models)
    .map(([key, { input, output, input_cached }]) => [
      key + (key === defaultModel ? " ⭐" : ""),
      moneyFmt.format(input * M) +
      (input_cached ? ` (${moneyFmt.format(input_cached * M)})` : ""),
      moneyFmt.format(output * M),
    ]),
])

const modelsMd = `# Models\n\n${modelsTable}`

// split from message content because we only want this in show or gist mode
function messageHeaderMd(msg: ChatMessage, msgNum: number, msgCount: number) {
  return `# ${msg.role} (${msgNum}/${msgCount})\n\n`
}

const timeFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

function messageContentMd(msg: ChatMessage, raw = false) {
  let output = ""

  if (msg.role === "assistant" && !raw) {
    // only show stop reason if it's not a natural stop
    const showStopReason = !["stop", "end_turn"].includes(msg.stop_reason.toLowerCase())

    output += codeMd(msg.model)
    output += ` | ${timeFmt.format(msg.timeMs / 1000)} s`
    output += ` | ${moneyFmt.format(msg.cost)}`

    // show cached tokens in parens if there are any
    const input = msg.tokens.input_cache_hit
      ? `${msg.tokens.input} (${msg.tokens.input_cache_hit})`
      : msg.tokens.input
    output += ` | **Tokens:** ${input} -> ${msg.tokens.output}`
    if (showStopReason) output += ` | **Stop reason:** ${msg.stop_reason}`

    output += "\n\n"
  }

  output += msg.content
  if (!args.raw) output += "\n\n"
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

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "numeric",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
})

// --------------------------------
// Key functionality
// --------------------------------

/** Errors and exits if it can't resolve to a model */
async function resolveModel(modelArg: string | undefined): Promise<Model> {
  if (modelArg === undefined) return defaultModel
  if (modelArg.trim() === "") {
    await printError(`\`-m/--model\` flag requires an argument\n\n${modelsMd}`)
    Deno.exit(1)
  }

  // Find the first model containing the arg as a substring. See comment at
  // allModels definition about ordering.
  const match = R.keys(models).find((m) => m.includes(modelArg.toLowerCase()))

  if (!match) {
    await printError(`'${modelArg}' isn't a substring of any model name.\n\n${modelsMd}`)
    Deno.exit(1)
  }

  return match
}

function createMessage(input: ChatInput): Promise<ModelResponse> {
  if (input.model.startsWith("claude")) return claudeCreateMessage(input)
  if (input.model.startsWith("gemini")) return geminiCreateMessage(input)
  if (input.model.startsWith("deepseek")) return deepseekCreateMessage(input)
  if (input.model.startsWith("cerebras-")) {
    return cerebrasCreateMessage({ ...input, model: input.model.slice(9) })
  }
  if (input.model.startsWith("groq-")) {
    return groqCreateMessage({ ...input, model: input.model.slice(5) })
  }
  return gptCreateMessage(input)
}

// --------------------------------
// CLI structure
// --------------------------------

type Command =
  | { cmd: "clear" }
  | { cmd: "show"; n: number | undefined }
  | { cmd: "gist"; title: string | undefined; n: number | undefined }
  | { cmd: "message"; content: string }
  | { cmd: "history" }
  | { cmd: "resume" }

function parseCmd(a: typeof args): Command {
  const [cmd, ...rest] = a._
  // only relevant in gist and show
  const n = a.all ? undefined : (typeof a.n === "number" ? a.n : 1)

  // simple commands
  if (rest.length === 0) {
    if (cmd === "clear") return { cmd: "clear" }
    if (cmd === "history") return { cmd: "history" }
    if (cmd === "resume") return { cmd: "resume" }
    if (cmd === "show") return { cmd: "show", n }
  }

  // a message would never start with gist
  // default n is undefined, which means all
  if (cmd === "gist") {
    return { cmd: "gist", title: rest.join(" ") || undefined, n }
  }

  // otherwise, assume it's all one big chat message
  return { cmd: "message", content: a._.join(" ") }
}

const codeMd = (s: string) => `\`${s}\``
const codeListMd = (strs: string[]) => strs.map(codeMd).join(", ")

type Tool = "search" | "code"
const toolKeys: Tool[] = ["search", "code"]

async function parseTools(
  model: Model,
  tools: string[],
): Promise<Tool[]> {
  if (tools.length === 0) return []
  if (!model.startsWith("gemini")) {
    await printError("Tools can only be used with Gemini models")
    Deno.exit(1)
  }
  const badTools = tools.filter((t) => !(toolKeys as string[]).includes(t))
  if (badTools.length > 0) {
    await printError(
      `Invalid tools: ${codeListMd(badTools)}. Valid values are: ${codeListMd(toolKeys)}`,
    )
    Deno.exit(1)
  }
  return tools as Tool[]
}

// use a fast model to summarize a chat for display purposes
async function summarize(chat: Chat): Promise<string> {
  const firstMsg = chat.messages[0].content
  const abridged = firstMsg.length > 100
    ? firstMsg.slice(0, 50) + "..." + firstMsg.slice(-50)
    : firstMsg
  const summary = await cerebrasCreateMessage({
    chat: {
      systemPrompt:
        "You are summarizing LLM chats based on excerpts for use in a TUI conversation list. Be concise and accurate. Include details like names to help identify that chat. Only provide the summary; do not include explanation or followup questions. Do not end with a period.",
      messages: [],
      createdAt: "",
    },
    input:
      `Please summarize an LLM chat based on the following excerpt from the first message. Use as few words as possible. Ideally 3-6 words, but up to 10. \n\n<excerpt>${abridged}</excerpt>`,
    model: "llama-3.3-70b",
    tools: [],
  })
  return summary.content
}

/** Create and save summaries for any chat without one */
async function genMissingSummaries(history: Chat[]) {
  if (!Deno.env.get("CEREBRAS_API_KEY")) {
    $.logWarn("Skipping summarization:", "CEREBRAS_API_KEY not found")
    return
  }
  const pb = $.progress("Summarizing...")
  for (const chat of history) {
    if (!chat.summary) chat.summary = await summarize(chat)
  }
  Storage.write(history)
  pb.finish()
}

// --------------------------------
// Actually do the thing
// --------------------------------

const args = parseArgs(Deno.args, {
  boolean: ["help", "reply", "raw", "all"], // --all used for show only
  string: ["persona", "model", "system", "tool"],
  alias: { h: "help", m: "model", p: "persona", r: "reply", t: "tool", a: "all" },
  collect: ["tool"],
})

if (args.help) {
  await printHelp()
  Deno.exit()
}

const cmd = parseCmd(args)

const history = Storage.read()

if (cmd.cmd === "clear") {
  const n = history.length
  const yes = await $.maybeConfirm(`Delete ${n} chats?`, { noClear: true })
  if (yes) {
    Storage.clear()
    console.log("Deleted history from localStorage")
  } else {
    console.log("No changes made")
  }
  Deno.exit()
}

// check for no other args because a prompt could start with "show", and we
// still want to treat that as a prompt
if (cmd.cmd === "show") {
  const lastChat = history.at(-1) // last one is current
  if (!lastChat) {
    await printError("No chat in progress")
    Deno.exit(1)
  }
  await renderMd(chatToMd(lastChat, cmd.n), args.raw)
  Deno.exit()
}

if (cmd.cmd === "gist") {
  const lastChat = history.at(-1) // last one is current
  if (!lastChat) {
    await printError("No chat in progress")
    Deno.exit(1)
  }
  if (!$.commandExistsSync("gh")) {
    await printError("Creating a gist requires the `gh` CLI (https://cli.github.com/)")
    Deno.exit(1)
  }
  const filename = cmd.title ? `LLM chat - ${cmd.title}.md` : "LLM chat.md"
  await $`gh gist create -f ${filename}`.stdinText(chatToMd(lastChat, cmd.n))
  Deno.exit()
}

if (cmd.cmd === "history") {
  await genMissingSummaries(history)
  const rows = history
    .map((chat) => [
      chat.createdAt,
      chat.messages.findLast(isAssistant)?.model,
      chat.summary,
      chat.messages.length.toString(),
    ])
  await renderMd(markdownTable([["Start time", "Model", "Summary", "Messages"], ...rows]))
  Deno.exit()
}

// 1. pick a conversation with $.select
// 2. pull it out of the list and put it on top
// 3. write history
if (cmd.cmd === "resume") {
  await genMissingSummaries(history)
  const selectedIdx = await $.select({
    message: "Pick a chat to resume",
    options: history.map((chat) =>
      `${chat.summary} (${chat.createdAt}, ${chat.messages.length} messages)`
    ),
    noClear: true,
  })
  // pop out the selected item and move it to the end
  const [before, after] = R.splitAt(history, selectedIdx)
  const [selected, rest] = R.splitAt(after, 1)
  const newHistory = [...before, ...rest, ...selected]
  Storage.write(newHistory)
  Deno.exit()
}

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

// if we're not continuing an existing conversation, pop a new one onto history
if (!args.reply || history.length === 0) {
  history.push({
    // TODO: just store the actual date value
    createdAt: dateFmt.format(new Date()).replace(",", ""),
    systemPrompt,
    messages: [],
  })
}

// now we're guaranteed to have one on hand, and that's our current one.
// we modify it by reference
const chat: Chat = history.at(-1)!

// -r uses same model as last response, but only if there is one and no model is specified
const prevModel = chat.messages.findLast(isAssistant)?.model
const model = args.reply && prevModel && !args.model
  ? prevModel
  : await resolveModel(args.model)
const tools = await parseTools(model, args.tool)

// don't want progress spinner when piping output
const pb = Deno.stdout.isTerminal() && !args.raw ? $.progress("Thinking...") : null

try {
  const startTime = performance.now()
  const response = await createMessage({ chat, input, model, tools })
  if (pb) pb.finish()
  const timeMs = performance.now() - startTime
  const assistantMsg = {
    role: "assistant" as const,
    model,
    ...response,
    cost: getCost(model, response.tokens),
    timeMs,
  }
  chat.messages.push({ role: "user", content: input }, assistantMsg)
  Storage.write(history)
  await renderMd(messageContentMd(assistantMsg, args.raw), args.raw)
  // deno-lint-ignore no-explicit-any
} catch (e: any) {
  if (pb) pb.finish() // otherwise it hangs around
  if (e.response?.status) console.log("Request error:", e.response.status)
  if (e.response?.data) renderMd(jsonBlock(e.response.data))
  if (e.response?.error) renderMd(jsonBlock(e.response.error))
  if (!("response" in e)) renderMd(codeBlock(e))
}
