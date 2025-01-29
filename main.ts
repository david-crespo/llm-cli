#! /usr/bin/env -S deno run --allow-env --allow-read --allow-net --allow-run=gh,glow

import { readAll } from "jsr:@std/io@0.224"
import { Command, ValidationError } from "jsr:@cliffy/command@1.0.0-rc.7"
import { Table } from "jsr:@cliffy/table@1.0.0-rc.7"
import $ from "jsr:@david/dax@0.42"

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

/**
 * 1. pick a conversation with `$.select`
 * 2. pull it out of the list and put it on top
 * 3. write history
 */
async function resumePicker() {
  const history = History.read()
  await genMissingSummaries(history)
  const reversed = R.reverse(history)
  // would be 2 indent for prompt >, but after you select one it's 3
  const selectedIdx = await $.select({
    message: "Pick a chat to resume",
    // use cliffy's table to align columns, then split on newline to get lines as strings
    options: new Table(...reversed.map((chat) => {
      const date = dateFmt.format(chat.createdAt).replace(",", "")
      return [chat.summary || "", `${date} (${chat.messages.length})`]
    }))
      .padding(3)
      .toString().split("\n"),
    noClear: true,
  })
  // pop out the selected item and move it to the end
  const [before, after] = R.splitAt(reversed, selectedIdx)
  const [selected, rest] = R.splitAt(after, 1)
  // put it at the beginning so it's at the end after re-reversing
  const newHistory = [...selected, ...before, ...rest]
  History.write(R.reverse(newHistory))
}

const historyCmd = new Command()
  .description("List and resume recent chats")
  .action(resumePicker)
  .command("list", "List and resume recent chats")
  .action(resumePicker)
  .command("clear", "Delete current chat from localStorage")
  .action(async () => {
    const history = History.read()
    const n = history.length
    const yes = await $.maybeConfirm(`Delete ${n} chats?`, { noClear: true })
    if (yes) {
      History.clear()
      console.log("Deleted history from localStorage")
    } else {
      console.log("No changes made")
    }
  })

const showCmd = new Command()
  .description("Show chat so far (last N, default 1)")
  .option("-a, --all", "Show all messages")
  .option("-n, --limit <n:integer>", "Number of messages", { default: 1 })
  .option("--raw <raw:boolean>", "Raw output, not rendered")
  .action(async (opts) => {
    const history = History.read()
    const lastChat = history.at(-1) // last one is current
    if (!lastChat) {
      await printError("No chat in progress")
      Deno.exit(1)
    }
    const n = opts.all ? lastChat.messages.length : opts.limit
    await renderMd(chatToMd(lastChat, n), opts.raw)
  })

const gistCmd = new Command()
  .description("Save chat to GitHub Gist with gh CLI")
  .option("-t, --title <title>", "Gist title")
  .option("-a, --all", "Include all messages")
  .option("-n, --limit <n:integer>", "Number of messages to include")
  .action(async (opts) => {
    const history = History.read()
    const lastChat = history.at(-1) // last one is current
    if (!lastChat) {
      await printError("No chat in progress")
      Deno.exit(1)
    }
    if (!$.commandExistsSync("gh")) {
      await printError("Creating a gist requires the `gh` CLI (https://cli.github.com/)")
      Deno.exit(1)
    }
    const filename = opts.title ? `LLM chat - ${opts.title}.md` : "LLM chat.md"
    const n = opts.all ? lastChat.messages.length : opts.limit
    await $`gh gist create -f ${filename}`.stdinText(chatToMd(lastChat, n))
  })

const modelsCmd = new Command()
  .description("List models")
  .action(() => renderMd(modelsMd))

await new Command()
  .name("ai")
  .description(`
Input from either [message] or stdin is required unless using a
command. If both are present, stdin will be appended to MESSAGE.

By default, this script will attempt to render output with glow,
but if glow is not present or output is being piped, it will print
the raw output to stdout.`)
  // top level subcommands
  .command("show", showCmd)
  .command("history", historyCmd)
  .command("gist", gistCmd)
  .command("models", modelsCmd)
  .reset()
  // top level `ai hello how are you` command
  .arguments("[message...]")
  .helpOption("-h, --help", "Show help")
  .option("-r, --reply", "Continue existing chat")
  .option("-m, --model <model:string>", "Select model by substring (e.g., 'sonnet')")
  .option("-t, --tools <tools:string>", "Use tools ('search' or 'code', Gemini only)", {
    collect: true,
  })
  .option("-p, --persona <persona:string>", "Override persona in system prompt")
  .option("-s, --system <system:string>", "Override entire system prompt")
  .option("--raw", "Print LLM text directly (no metadata)")
  .example("ai 'What is the capital of France?'", "")
  .example("cat main.ts | ai 'what is this?'", "")
  .example("echo 'what are you?' | ai", "")
  .example("ai -r 'elaborate on that'", "")
  .example("ai -m 4o 'What are generic types?'", "")
  .example("ai gist -t 'Generic types'", "")
  .action(async (opts, ...args) => {
    const msg = args.join(" ")
    const stdin = Deno.stdin.isTerminal()
      ? null
      // read stdin to end
      : new TextDecoder().decode(await readAll(Deno.stdin)).trim()

    if (!msg && !stdin) {
      throw new ValidationError("Message, stdin, or command is required")
    }
    const input = [stdin, msg].filter(Boolean).join("\n\n")

    const persona = opts.persona ? `You are ${opts.persona}. ` : ""

    const systemBase =
      "Your answers are precise. Answer only the question as asked. If the answer is a simple yes or no, include a little explanation if it would be helpful. When asked for code, only output code: do not explain unless asked to. Your answers must be in markdown format."

    const systemPrompt = opts.system || (persona + systemBase)

    const history = History.read()
    // if we're not continuing an existing conversation, pop a new one onto history
    if (!opts.reply || history.length === 0) {
      history.push({
        createdAt: new Date(),
        systemPrompt,
        messages: [],
      })
    }

    // now we're guaranteed to have one on hand, and that's our current one.
    // we modify it by reference
    const chat: Chat = history.at(-1)!

    // -r uses same model as last response, but only if there is one and no model is specified
    const prevModel = chat.messages.findLast(isAssistant)?.model
    const model = opts.reply && prevModel && !opts.model
      ? prevModel
      : await resolveModel(opts.model)
    const tools = await parseTools(model, opts.tools || [])

    // don't want progress spinner when piping output
    const pb = Deno.stdout.isTerminal() && !opts.raw ? $.progress("Thinking...") : null

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
      await renderMd(messageContentMd(assistantMsg, opts.raw), opts.raw)
      // deno-lint-ignore no-explicit-any
    } catch (e: any) {
      if (pb) pb.finish() // otherwise it hangs around
      if (e.response?.status) console.log("Request error:", e.response.status)
      if (e.response?.data) renderMd(jsonBlock(e.response.data))
      if (e.response?.error) renderMd(jsonBlock(e.response.error))
      if (!("response" in e)) renderMd(codeBlock(e))
    }
  })
  .parse(Deno.args)
