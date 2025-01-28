#! /usr/bin/env -S deno run --allow-env --allow-read --allow-net --allow-run=gh,glow

import { readAll } from "jsr:@std/io@0.224"
import { parseArgs } from "jsr:@std/cli@1.0/parse-args"
import $ from "jsr:@david/dax@0.42"
import { markdownTable } from "https://esm.sh/markdown-table@3.0.4"

import * as R from "npm:remeda@2.19"

import { defaultModel, type Model, models } from "./models.ts"
import {
  chatToMd,
  codeBlock,
  codeListMd,
  dateFmt,
  jsonBlock,
  messageContentMd,
  modelsMd,
  printError,
  renderMd,
} from "./display.ts"
import { Chat, isAssistant, TokenCounts } from "./types.ts"
import { createMessage } from "./adapters.ts"
import { History } from "./storage.ts"
import { genMissingSummaries } from "./summarize.ts"

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

// returning never tells the calling code that this function exits
export async function printHelp() {
  await renderMd(HELP + "\n" + modelsMd)
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

/** Errors and exits if it can't resolve to a model */
export async function resolveModel(modelArg: string | undefined): Promise<Model> {
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

const history = History.read()

if (cmd.cmd === "clear") {
  const n = history.length
  const yes = await $.maybeConfirm(`Delete ${n} chats?`, { noClear: true })
  if (yes) {
    History.clear()
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
  History.write(newHistory)
  Deno.exit()
}

const stdin = Deno.stdin.isTerminal()
  ? null
  // read stdin to end
  : new TextDecoder().decode(await readAll(Deno.stdin)).trim()

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
  History.write(history)
  await renderMd(messageContentMd(assistantMsg, args.raw), args.raw)
  // deno-lint-ignore no-explicit-any
} catch (e: any) {
  if (pb) pb.finish() // otherwise it hangs around
  if (e.response?.status) console.log("Request error:", e.response.status)
  if (e.response?.data) renderMd(jsonBlock(e.response.data))
  if (e.response?.error) renderMd(jsonBlock(e.response.error))
  if (!("response" in e)) renderMd(codeBlock(e))
}
