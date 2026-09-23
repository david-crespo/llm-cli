#! /usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-net --allow-run=gh,osascript

import { readAll } from "@std/io"
import { Command, EnumType, ValidationError } from "@cliffy/command"
import { Table } from "@cliffy/table"
import $ from "@david/dax"

import * as R from "remeda"

import { resolveModel, systemBase } from "./models.ts"
import {
  chatToMd,
  codeBlock,
  type DisplayOpts,
  formatElapsed,
  getMode,
  jsonBlock,
  modelsMd,
  renderMd,
  renderResponse,
  shortDateFmt,
} from "./display.ts"
import { parseMessageSpec, resolveImage } from "./utils.ts"
import { type Chat, resolveThink, type ThinkOverride } from "./types.ts"
import {
  type ChatInput,
  claudeAdaptiveThinking,
  createMessage,
  gptBg,
  imageInputProviders,
  imageQualities,
  type ModelResponse,
  searchProviders,
  thinkProviders,
  type ToolConfig,
  validateConfig,
} from "./adapters/mod.ts"
import { History } from "./storage.ts"
import { genMissingSummaries } from "./summarize.ts"
import { parseType } from "./schema.ts"
import { formatPickerOptions } from "./picker.ts"

const getLastModelId = (chat: Chat) =>
  chat.messages.findLast((m) => m.role === "assistant")?.model

const truncate = (str: string, maxLength: number) =>
  str.length > maxLength ? str.slice(0, maxLength) + "..." : str

/** Keep one width-aware selector option per chat so option indexes stay aligned. */
function chatPickerOptions(chats: Chat[]) {
  return formatPickerOptions(chats.map((chat) => {
    const date = shortDateFmt.format(chat.createdAt).replace(",", "")
    return {
      summary: chat.summary || "",
      model: getLastModelId(chat) || "",
      meta: `${date} (${chat.messages.length})`,
    }
  }))
}

/** use cliffy's table to align columns for message picker, then split on newline to get lines as strings */
function messagePickerOptions(messages: Chat["messages"]) {
  const table = new Table(...messages.map((msg, i) => {
    const preview = truncate(msg.content.replace(/\n/g, " "), 50)
    const actor = msg.role === "assistant" ? msg.model : "user"
    return [`${i + 1}`, actor, preview]
  }))
  return table.padding(3).toString().split("\n")
}

const bell = () => Deno.stdout.write(new TextEncoder().encode("\x07"))

const makeAssMsg = (modelId: string, startTime: number, response: ModelResponse) => ({
  role: "assistant" as const,
  model: modelId,
  createdAt: new Date(),
  timeMs: Date.now() - startTime,
  ...response,
})

const createChat = (systemPrompt: string): Chat => ({
  id: crypto.randomUUID(),
  createdAt: new Date(),
  systemPrompt,
  messages: [],
})

// deno-lint-ignore no-explicit-any
function renderError(e: any, opts: DisplayOpts = {}) {
  Deno.exitCode = 1
  // keep stdout clean for scripts: JSON mode reports errors on stderr only
  if (opts.json) {
    const detail = e.response?.data ?? e.response?.error
    console.error(e instanceof Error ? e.message : String(e))
    if (detail) console.error(JSON.stringify(detail, null, 2))
    return
  }
  if (e.response?.status) console.log("Request error:", e.response.status)
  if (e.response?.data) renderMd(jsonBlock(e.response.data))
  if (e.response?.error) renderMd(jsonBlock(e.response.error))
  if (!("response" in e)) renderMd(codeBlock(e))
}

async function pollBackgroundResponse(
  chat: Chat,
  model: { id: string; provider: string },
  displayOpts: DisplayOpts,
) {
  if (!chat.background) throw new Error("No background response to poll")

  const { id, startedAt, modelId, effort } = chat.background
  const showProgress = Deno.stdout.isTerminal() && !displayOpts.raw && !displayOpts.json
  const pb = showProgress ? $.progress("Waiting...") : null

  try {
    const startTime = startedAt.getTime()
    while (true) {
      const status = await gptBg.status(id)
      if (status !== "queued" && status !== "in_progress") {
        chat.background.status = status
        break
      }

      const elapsed = Date.now() - startTime
      if (pb) pb.message(`${formatElapsed(elapsed)} (${status})`)
      await new Promise((res) => setTimeout(res, 5000))
    }

    if (pb) pb.finish()

    if (chat.background.status === "completed") {
      const response = {
        ...await gptBg.retrieve(id, resolveModel(modelId)),
        effort,
      }
      const assistantMsg = makeAssMsg(model.id, startTime, response)
      chat.messages.push(assistantMsg)
      delete chat.background
      await renderResponse(assistantMsg, displayOpts)
    } else {
      const { status } = chat.background
      delete chat.background
      Deno.exitCode = 1
      console.log(`Background response ${status}`)
    }
  } finally {
    if (pb) pb.finish()
    if (showProgress) await bell()
  }
}

/**
 * Generate a response for a chat with the given input and options
 */
async function genResponse(
  chatInput: ChatInput,
  displayOpts: DisplayOpts = {},
) {
  // don't want progress spinner when piping output
  const showProgress = Deno.stdout.isTerminal() && !displayOpts.raw && !displayOpts.json
  const label = chatInput.model.kind === "image" ? "Generating image..." : "Thinking..."
  const pb = showProgress ? $.progress(label) : null

  // Set up abort signal for non-background requests. Let's handle SIGTERM in
  // case it's relevant when this CLI gets called by another script.
  const abortController = new AbortController()
  const sigintHandler = () => abortController.abort()
  const sigtermHandler = () => abortController.abort()
  Deno.addSignalListener("SIGINT", sigintHandler)
  Deno.addSignalListener("SIGTERM", sigtermHandler)

  try {
    const startTime = Date.now()
    const response = await createMessage({
      ...chatInput,
      signal: abortController.signal,
    })
    if (pb) pb.finish()
    const assistantMsg = makeAssMsg(chatInput.model.id, startTime, response)
    chatInput.chat.messages.push(assistantMsg)
    await renderResponse(assistantMsg, displayOpts)
  } catch (e: unknown) {
    renderError(e, displayOpts)
  } finally {
    Deno.removeSignalListener("SIGINT", sigintHandler)
    Deno.removeSignalListener("SIGTERM", sigtermHandler)
    if (pb) pb.finish() // otherwise it hangs around
    // terminal bell to indicate it's done
    if (showProgress) await bell()
  }
}

async function pickChat(message: string) {
  const history = History.list()
  await genMissingSummaries(history)
  if (history.length === 0) throw new ValidationError("No chat history")

  const reversed = R.reverse(history)
  const { index: selectedIdx } = await $.select({
    message,
    options: chatPickerOptions(reversed),
    noClear: true,
  })
  const selected = reversed[selectedIdx]
  return selected
}

async function pickAndResume() {
  const selected = await pickChat("Pick a chat to resume")
  History.touch(selected.id)
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
    const selected = await pickChat("Pick a chat to show")
    const n = opts.all ? selected.messages.length : opts.limit
    await renderMd(chatToMd({ chat: selected, lastN: n }))
  })
  .command("delete", "Pick recent chats to delete")
  .action(async () => {
    const history = History.list()
    await genMissingSummaries(history)
    if (history.length === 0) throw new ValidationError("No chat history")

    const reversed = R.reverse(history)
    const selected = await $.multiSelect({
      message: "Pick chats to delete",
      options: chatPickerOptions(reversed),
      noClear: true,
    })
    if (selected.length === 0) return
    const label = `${selected.length} chat${selected.length === 1 ? "" : "s"}`
    const yes = await $.maybeConfirm(`Delete ${label}?`, { noClear: true })
    if (!yes) return
    History.delete(selected.map((s) => reversed[s.index].id))
    console.log(`Deleted ${label}`)
  })
  .command("clear", "Delete saved chat history")
  .action(async () => {
    const history = History.list()
    const n = history.length
    const yes = await $.maybeConfirm(`Delete ${n} chats?`, { noClear: true })
    if (!yes) return
    History.clear()
    console.log("Deleted chat history")
  })

const showCmd = new Command()
  .description("Show chat so far (last N, default 1)")
  .option("-a, --all", "Show all messages")
  .option("-n, --limit <n:integer>", "Number of messages (default 1)", { default: 1 })
  .option(
    "-p, --pick <spec:string>",
    "Pick specific messages (e.g., '1,3-4,7', 'even', 'odd')",
  )
  .option("-v, --verbose", "Include reasoning in output")
  .option("--raw", "Print LLM output directly (no metadata or reasoning)")
  .action(async (opts) => {
    const chat = History.current()
    if (!chat) throw new ValidationError("No chat in progress")
    const mode = getMode(opts)
    if (opts.pick) {
      const indices = parseMessageSpec(opts.pick, chat.messages.length)
      await renderMd(chatToMd({ chat, indices, mode }), opts.raw)
    } else {
      const lastN = opts.all ? chat.messages.length : opts.limit
      await renderMd(chatToMd({ chat, lastN, mode }), opts.raw)
    }
  })

const gistCmd = new Command()
  .description("Save chat to GitHub Gist with gh CLI")
  .option("-t, --title <title>", "Gist title")
  .option("-a, --all", "Include all messages")
  .option("-n, --limit <n:integer>", "Number of messages (default 1)", { default: 1 })
  .option(
    "-p, --pick <spec:string>",
    "Pick specific messages (e.g., '1,3-4,7', 'even', 'odd')",
  )
  .option("--id <id:string>", "Replace contents of an existing gist by ID")
  .action(async (opts) => {
    const lastChat = History.current()
    if (!lastChat) throw new ValidationError("No chat in progress")
    await genMissingSummaries([lastChat])

    if (!$.commandExistsSync("gh")) {
      throw new Error(
        "Creating a gist requires the `gh` CLI (https://cli.github.com/)",
      )
    }

    let md: string
    if (opts.pick) {
      const indices = parseMessageSpec(opts.pick, lastChat.messages.length)
      md = chatToMd({ chat: lastChat, indices, mode: "gist" })
    } else {
      const n = opts.all ? lastChat.messages.length : opts.limit
      md = chatToMd({ chat: lastChat, lastN: n, mode: "gist" })
    }

    if (opts.id) {
      await $`gh gist edit ${opts.id} -`.stdinText(md)
    } else {
      const title = opts.title || lastChat.summary
      const filename = title ? `LLM chat - ${title}.md` : "LLM chat.md"
      await $`gh gist create -f ${filename} --web`.stdinText(md)
    }
  })

function modelInfoMd(modelArg: string) {
  const model = resolveModel(modelArg)
  const { provider, key, id } = model

  const lines = [`**${id}** (${provider})`, `key: \`${key}\``]

  if (model.kind === "image") {
    lines.push(
      `image generation: --quality ${imageQualities.join("|")}, --size WxH|auto`,
      "output: PNG saved under ~/.local/state/llm-cli/images",
    )
    return lines.join("\n")
  }

  if (searchProviders.has(provider)) {
    lines.push("search: yes")
  }

  if (thinkProviders.has(provider)) {
    if (provider === "anthropic") {
      if (claudeAdaptiveThinking(key)) {
        lines.push("think: adaptive (high), --quick for low, --think-hard for xhigh")
      } else {
        lines.push("think: --think (4k), --think-hard (16k)")
      }
    } else if (provider === "openai") {
      lines.push("think: medium by default, --think-hard for high, --quick for none")
    } else if (provider === "google") {
      const level = key.includes("flash-lite") ? "minimal" : "low"
      lines.push(`think: dynamic by default, --quick for ${level}`)
    } else if (provider === "baseten") {
      lines.push("think: on by default, --quick to disable")
    }
  }

  return lines.join("\n")
}

const modelsCmd = new Command()
  .description("List models or show info for a specific model")
  .argument("[model:string]", "Model key or substring")
  .option("-v, --verbose", "Show model keys")
  .action((opts, modelArg) => {
    if (modelArg) {
      renderMd(modelInfoMd(modelArg))
    } else {
      renderMd(modelsMd(opts.verbose))
    }
  })

const forkCmd = new Command()
  .description("Fork chat from a specific message with a different model")
  .option("-m, --model <model:string>", "Select model by substring (e.g., 'sonnet')", {
    required: true,
  })
  .action(async (opts) => {
    const model = resolveModel(opts.model)
    if (model.kind === "image") {
      throw new ValidationError(
        "Image models cannot fork chats. Use -m with a fresh prompt",
      )
    }
    const currentChat = History.current()
    if (!currentChat || currentChat.messages.length === 0) {
      throw new ValidationError("No chat in progress")
    }

    const { index: selectedIdx } = await $.select({
      message: "Pick a message to fork from",
      options: messagePickerOptions(currentChat.messages),
      noClear: true,
    })

    const selectedMessage = currentChat.messages[selectedIdx]
    const newChat: Chat = {
      ...createChat(currentChat.systemPrompt),
      messages: currentChat.messages.slice(0, selectedIdx + 1),
      summary: currentChat.summary,
    }

    if (selectedMessage.role === "user") {
      const chatInput: ChatInput = {
        chat: newChat,
        model,
        config: { search: false, think: undefined },
      }
      await genResponse(chatInput, {})
    } else {
      console.log(
        `Forked on assistant message with model ${model.id}. You can now continue the chat.`,
      )
    }
    History.save(newChat, { current: true, touch: true })
  })

function exit(msg: string): never {
  console.log(msg)
  Deno.exit()
}

const bgCmd = new Command()
  .description("Manage background responses")
  .action(() => {
    throw new ValidationError("Subcommand required")
  })
  .command("status", "Check status of current chat's background request")
  .action(async () => {
    const chat = History.findLatestBackground()
    if (!chat?.background) exit("No background task found")

    const status = await gptBg.status(chat.background.id)
    const elapsed = Date.now() - chat.background.startedAt.getTime()
    console.log(`${formatElapsed(elapsed)} (${status})`)
  })
  .command("resume", "Resume polling for current chat's background request")
  .action(async () => {
    const chat = History.findLatestBackground()
    if (!chat?.background) exit("No background task found")

    const model = { id: chat.background.modelId, provider: chat.background.provider }
    await pollBackgroundResponse(chat, model, {})
    History.save(chat)
  })
  .command("cancel", "Cancel current chat's background request")
  .action(async () => {
    const chat = History.findLatestBackground()
    if (!chat?.background) exit("No background task found")

    await gptBg.cancel(chat.background.id)
    delete chat.background
    History.save(chat)
    console.log("Background response cancelled")
  })

await new Command()
  .name("ai")
  .description(`
Input from [message], stdin, or --image is required unless using a
command. If both message and stdin are present, stdin will be appended
to MESSAGE.

By default, this script will attempt to render output with glow,
but if glow is not present or output is being piped, it will print
the raw output to stdout.`)
  // top level subcommands
  .command("show", showCmd)
  .command("history", historyCmd)
  .command("fork", forkCmd)
  .command("gist", gistCmd)
  .command("models", modelsCmd)
  .command("bg", bgCmd)
  .reset()
  // top level `ai hello how are you` command
  .argument("[message...]", "Message to send to the LLM")
  .helpOption("-h, --help", "Show help")
  .help({ hints: false })
  .option("-r, --reply", "Continue existing chat")
  .option("-m, --model <model:string>", "Select model by substring (e.g., 'sonnet')")
  .option("-s, --search", "Enable web search (sticky: stays on for -r replies)")
  .option("--no-search", "Disable web search for this turn")
  .option("--think", "Enable thinking")
  .option("--think-hard", "Enable maximum thinking")
  .option("-q, --quick", "Minimize thinking")
  .option("--think-default", "Clear inherited thinking and use the model default")
  .option(
    "-i, --image <value:string>",
    "Image: URL, local file path, or 'clipboard' (macOS)",
  )
  .type("quality", new EnumType(imageQualities))
  .option("--quality <quality:quality>", "Image quality (image models only)")
  .option("--size <size:string>", "Image size, e.g. 1024x1536 or auto (image models only)")
  .option("--system <system:string>", "Override entire system prompt")
  .option("-e, --ephemeral", "Don't save to history")
  .option("-b, --background", "Use background mode (OpenAI only)")
  .option("-v, --verbose", "Include reasoning in output")
  .option("--raw", "Print LLM text directly (no metadata or reasoning)")
  .option("--json", "Print the full response message as JSON (for scripts)", {
    conflicts: ["raw", "verbose"],
  })
  .option("-o, --output-schema <schema:string>", "ArkType schema for structured output")
  .example("1)", "ai 'What is the capital of France?'")
  .example("2)", "cat main.ts | ai 'what is this?'")
  .example("3)", "echo 'what are you?' | ai")
  .example("4)", "ai -r 'elaborate on that'")
  .example("5)", "ai -m 4o 'What are generic types?'")
  .example(
    "6)",
    "ai -o '{ urgent: \"boolean\", reason: \"string\" }' 'is this urgent? server is down'",
  )
  .example("7)", "ai gist -t 'Generic types'")
  .example("8)", "ai -m flare --quality low 'a lighthouse at dusk'")
  .action(async (opts, ...args) => {
    let outputSchema
    if (opts.outputSchema) {
      try {
        outputSchema = parseType(opts.outputSchema)
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e))
        Deno.exit(1)
      }
    }

    const msg = args.join(" ")
    const piped = !Deno.stdin.isTerminal()
    const stdin = piped
      // read stdin to end
      ? new TextDecoder().decode(await readAll(Deno.stdin)).trim()
      : null

    // Input was piped but arrived empty — the upstream command likely failed or
    // produced nothing (e.g. `cb x | ai ...` where `cb` errors). Abort rather
    // than calling the API with only the message.
    if (piped && !stdin && !opts.image) {
      throw new ValidationError(
        "Piped input was empty (did an upstream command fail?)",
      )
    }

    if (!msg && !stdin && !opts.image) {
      throw new ValidationError("Message, stdin, image, or command is required")
    }
    const input = [stdin, msg].filter(Boolean).join("\n\n")

    const systemPrompt = opts.system || systemBase

    const chat = opts.reply ? History.current() : createChat(systemPrompt)
    if (!chat) throw new ValidationError("Can't reply: no chat in progress")

    if (opts.reply && chat.background) {
      throw new ValidationError(
        "Current chat has a pending background response. Run `ai bg resume` or `ai bg cancel` before replying.",
      )
    }

    // -r uses same model as last response, but only if there is one and no model is specified
    const prevModelId = getLastModelId(chat)
    const model = resolveModel(
      opts.reply && prevModelId && !opts.model ? prevModelId : opts.model,
    )
    // Search is sticky across replies: an explicit -s/--no-search wins, else a
    // reply inherits the chat's last setting. Persisting it keeps the search
    // tool stable across turns so prompt caching keeps hitting — every provider
    // caches on a request prefix that includes the tool definitions, so toggling
    // search busts the cache (see Chat.search in types.ts).
    const search = opts.search ?? (opts.reply ? chat.search : undefined) ?? false
    chat.search = search
    const thinkOverride: ThinkOverride = opts.quick
      ? "off"
      : opts.thinkHard
      ? "high"
      : opts.think
      ? "on"
      : opts.thinkDefault
      ? "default"
      : undefined
    const think = resolveThink(thinkOverride, opts.reply ? chat.think : undefined)
    chat.think = think
    const config: ToolConfig = {
      search,
      think,
    }
    validateConfig(model.provider, config)

    if (model.kind === "image") {
      // Image models only take a fresh text prompt for now
      const unsupported = [
        opts.reply && "-r (use -m to pick a text model)",
        opts.system !== undefined && "--system",
        opts.image && "--image",
        search && "--search",
        think !== undefined && "thinking flags",
        outputSchema && "--output-schema",
        opts.background && "--background",
      ].filter(Boolean)
      if (unsupported.length > 0) {
        throw new ValidationError(
          `Not supported for image models: ${unsupported.join(", ")}`,
        )
      }
      if (opts.size && !/^(auto|\d+x\d+)$/.test(opts.size)) {
        throw new ValidationError(`Invalid size '${opts.size}'. Use WIDTHxHEIGHT or auto`)
      }
    } else if (opts.quality || opts.size) {
      throw new ValidationError("--quality and --size only apply to image models")
    }

    if (opts.image && !imageInputProviders.has(model.provider)) {
      throw new ValidationError(`Images not supported for ${model.provider}`)
    }
    const image_url = opts.image ? await resolveImage(opts.image) : undefined
    if (opts.background && model.provider !== "openai") {
      throw new ValidationError("Background mode only works with OpenAI models")
    }
    if (outputSchema && (opts.background || model.id === "gpt-5.4-pro")) {
      throw new ValidationError("Structured output is not supported in background mode")
    }

    chat.messages.push({
      role: "user",
      content: input,
      createdAt: new Date(),
      image_url,
      outputSchema: outputSchema?.expression,
    })
    const chatInput: ChatInput = {
      chat,
      model,
      config,
      outputSchema,
      imageOptions: { quality: opts.quality, size: opts.size },
    }

    // no need to pass --background if using gpt-5-pro -- it always needs it
    if (opts.background || model.id === "gpt-5.4-pro") {
      try {
        const { id, status, effort } = await gptBg.initiate(chatInput)
        chat.background = {
          id,
          status,
          startedAt: new Date(),
          provider: "openai",
          modelId: model.id,
          effort,
        }
        if (!opts.ephemeral) History.save(chat, { current: true, touch: true })
        await pollBackgroundResponse(chat, model, R.pick(opts, ["raw", "verbose", "json"]))
        // deno-lint-ignore no-explicit-any
      } catch (e: any) {
        renderError(e, R.pick(opts, ["raw", "verbose", "json"]))
      }
    } else {
      await genResponse(chatInput, R.pick(opts, ["raw", "verbose", "json"]))
    }

    if (!opts.ephemeral) History.save(chat, { current: true, touch: true })
  })
  .parse(Deno.args)
