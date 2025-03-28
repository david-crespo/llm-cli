#! /usr/bin/env -S deno run --allow-env --allow-read --allow-net --allow-run=gh,glow

import { readAll } from "jsr:@std/io@0.224"
import { Command, ValidationError } from "jsr:@cliffy/command@1.0.0-rc.7"
import { Table } from "jsr:@cliffy/table@1.0.0-rc.7"
import $ from "jsr:@david/dax@0.42"

import * as R from "npm:remeda@2.19"

import { getCost, resolveModel, systemBase } from "./models.ts"
import {
  chatToMd,
  codeBlock,
  jsonBlock,
  messageContentMd,
  modelsMd,
  renderMd,
  shortDateFmt,
} from "./display.ts"
import { type Chat } from "./types.ts"
import { ChatInput, createMessage, parseTools } from "./adapters.ts"
import { History } from "./storage.ts"
import { genMissingSummaries } from "./summarize.ts"

const getLastModelId = (chat: Chat) =>
  chat.messages.findLast((m) => m.role === "assistant")?.model

/** use cliffy's table to align columns, then split on newline to get lines as strings */
function chatPickerOptions(chats: Chat[]) {
  const table = new Table(...chats.map((chat) => {
    const date = shortDateFmt.format(chat.createdAt).replace(",", "")
    const modelId = getLastModelId(chat)
    return [chat.summary || "", modelId, `${date} (${chat.messages.length})`]
  }))
  return table.padding(3).toString().split("\n")
}

/**
 * 1. pick a conversation with `$.select`
 * 2. pull it out of the list and put it on top
 * 3. write history
 */
async function pickAndResume() {
  const history = History.read()
  await genMissingSummaries(history)
  const reversed = R.reverse(history)
  const selectedIdx = await $.select({
    message: "Pick a chat to resume",
    options: chatPickerOptions(reversed),
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
  .action(pickAndResume)
  .command("resume", "Pick a recent chat to resume")
  .action(pickAndResume)
  .command("show", "Pick a recent chat to show")
  .option("-a, --all", "Show all messages")
  .option("-n, --limit <n:integer>", "Number of messages (default 1)", { default: 1 })
  .action(async (opts) => {
    const history = History.read()
    await genMissingSummaries(history)
    const reversed = R.reverse(history)
    const selectedIdx = await $.select({
      message: "Pick a chat to show",
      options: chatPickerOptions(reversed),
      noClear: true,
    })
    const selected = reversed[selectedIdx]
    const n = opts.all ? selected.messages.length : opts.limit
    await renderMd(chatToMd({ chat: selected, lastN: n }))
  })
  .command("clear", "Delete current chat from localStorage")
  .action(async () => {
    const history = History.read()
    const n = history.length
    const yes = await $.maybeConfirm(`Delete ${n} chats?`, { noClear: true })
    if (!yes) {
      console.log("No changes made")
      return
    }
    History.clear()
    console.log("Deleted history from localStorage")
  })

const showCmd = new Command()
  .description("Show chat so far (last N, default 1)")
  .option("-a, --all", "Show all messages")
  .option("-n, --limit <n:integer>", "Number of messages (default 1)", { default: 1 })
  .option("--raw", "Raw output, not rendered")
  .action(async (opts) => {
    const history = History.read()
    const chat = history.at(-1) // last one is current
    if (!chat) throw new ValidationError("No chat in progress")
    const lastN = opts.all ? chat.messages.length : opts.limit
    await renderMd(chatToMd({ chat, lastN, raw: opts.raw }), opts.raw)
  })

const gistCmd = new Command()
  .description("Save chat to GitHub Gist with gh CLI")
  .option("-t, --title <title>", "Gist title")
  .option("-a, --all", "Include all messages")
  .option("-n, --limit <n:integer>", "Number of messages (default 1)", { default: 1 })
  .action(async (opts) => {
    const history = History.read()
    await genMissingSummaries(history)
    const lastChat = history.at(-1) // last one is current
    if (!lastChat) throw new ValidationError("No chat in progress")

    if (!$.commandExistsSync("gh")) {
      throw new Error(
        "Creating a gist requires the `gh` CLI (https://cli.github.com/)",
      )
    }
    const title = opts.title || lastChat.summary
    const filename = title ? `LLM chat - ${title}.md` : "LLM chat.md"
    const n = opts.all ? lastChat.messages.length : opts.limit
    await $`gh gist create -f ${filename}`.stdinText(
      chatToMd({ chat: lastChat, lastN: n, verbose: true }),
    )
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
  .help({ hints: false }) // hides ugly (Conflicts: persona) hint
  .option("-r, --reply", "Continue existing chat")
  .option("-m, --model <model:string>", "Select model by substring (e.g., 'sonnet')")
  .option("-t, --tools <tools:string>", "Use tools (search, code, or think)", {
    collect: true,
  })
  .option("-i, --image <url:string>", "Image URL (Claude only)")
  .option("-p, --persona <persona:string>", "Override persona in system prompt")
  .option("-s, --system <system:string>", "Override entire system prompt", {
    conflicts: ["persona"],
  })
  .option("--raw", "Print LLM text directly (no metadata)")
  .option("-c, --cache", "Cache input (Anthropic only, others are automatic)")
  .example("1)", "ai 'What is the capital of France?'")
  .example("2)", "cat main.ts | ai 'what is this?'")
  .example("3)", "echo 'what are you?' | ai")
  .example("4)", "ai -r 'elaborate on that'")
  .example("5)", "ai -m 4o 'What are generic types?'")
  .example("6)", "ai gist -t 'Generic types'")
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
    const prevModelId = getLastModelId(chat)
    const model = resolveModel(
      opts.reply && prevModelId && !opts.model ? prevModelId : opts.model,
    )
    const tools = parseTools(model.provider, opts.tools || [])
    if (opts.cache && model.provider !== "anthropic") {
      throw new ValidationError("Manual caching only works for Anthropic")
    }
    if (opts.image && model.provider !== "anthropic") {
      throw new ValidationError("Image URLs only work for Anthropic")
    }

    // don't want progress spinner when piping output
    const pb = Deno.stdout.isTerminal() && !opts.raw ? $.progress("Thinking...") : null

    try {
      const startTime = performance.now()
      const chatInput: ChatInput = {
        chat,
        input,
        image_url: opts.image,
        model: model.key,
        tools,
        cache: opts.cache,
      }
      const response = await createMessage(model.provider, chatInput)
      if (pb) pb.finish()
      const timeMs = performance.now() - startTime
      const assistantMsg = {
        role: "assistant" as const,
        model: model.id,
        ...response,
        cost: getCost(model, response.tokens),
        timeMs,
      }
      chat.messages.push(
        { role: "user", content: input, image_url: opts.image },
        assistantMsg,
      )
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
