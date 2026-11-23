#!/usr/bin/env node

import process from "node:process"
import { text } from "node:stream/consumers"
import { Command, InvalidArgumentError, Option } from "@commander-js/extra-typings"
import $ from "dax"
import { blueBright, bold, magentaBright, red } from "ansis"

import { type Model, models, resolveModel, systemBase } from "./models.ts"
import {
  chatToMd,
  codeBlock,
  type DisplayOpts,
  formatElapsed,
  getMode,
  jsonBlock,
  modelsMd,
  renderMd,
  renderMdErr,
  renderResponse,
  shortDateFmt,
} from "./display.ts"
import { resolveImage } from "./image-input.ts"
import { parseMessageSpec } from "./message-spec.ts"
import { pick } from "./utils.ts"
import { ValidationError } from "./errors.ts"
import { type Chat, resolveThink, type ThinkOverride } from "./types.ts"
import {
  type ChatInput,
  createMessage,
  gptBg,
  imageQualities,
  type ModelResponse,
  searchProviders,
  thinkEfforts,
} from "./adapters/index.ts"
import { History } from "./storage.ts"
import { ensureConfigFile, getApiKey, profilesReport, resolveProfile } from "./config.ts"
import { genMissingSummaries } from "./summarize.ts"
import { requestProblems } from "./validate.ts"
import {
  alignColumns,
  confirmed,
  formatPickerOptions,
  pickWithAction,
  selectIndex,
  selectIndexes,
  singleLine,
} from "./picker.ts"

const getLastModelId = (chat: Chat) =>
  chat.messages.findLast((m) => m.role === "assistant")?.model

const truncate = (str: string, maxLength: number) =>
  str.length > maxLength ? str.slice(0, maxLength) + "..." : str

/** One single-line picker option per chat, with columns aligned */
function chatPickerOptions(chats: Chat[]) {
  return formatPickerOptions(
    chats.map((chat) => {
      const date = shortDateFmt.format(chat.createdAt).replace(",", "")
      return {
        summary: chat.summary || "",
        model: getLastModelId(chat) || "",
        meta: `${date} (${chat.messages.length})`,
      }
    }),
  )
}

/** One line per message for the fork picker, with columns aligned */
function messagePickerOptions(messages: Chat["messages"]) {
  return alignColumns(
    messages.map((msg, i) => {
      const preview = truncate(msg.content.replace(/\n/g, " "), 50)
      const actor = msg.role === "assistant" ? msg.model : "user"
      return [`${i + 1}`, actor, preview]
    }),
  )
}

const bell = () => new Promise((resolve) => process.stdout.write("\x07", resolve))

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

function apiErrorDetail(e: unknown): { status?: number; body?: unknown } {
  if (!e || typeof e !== "object") return {}
  const status = "status" in e && typeof e.status === "number" ? e.status : undefined
  if ("error" in e && e.error !== undefined) return { status, body: e.error }
  if (status !== undefined && e instanceof Error) {
    try {
      return { status, body: JSON.parse(e.message) }
    } catch {
      // Non-JSON message
    }
  }
  return { status }
}

async function renderError(e: unknown, opts: DisplayOpts = {}) {
  process.exitCode = 1
  const { status, body } = apiErrorDetail(e)
  const message = e instanceof Error ? e.message : String(e)
  if (opts.json) {
    console.error(message)
    if (body !== undefined) console.error(JSON.stringify(body, null, 2))
    return
  }
  if (status !== undefined) console.error("Request error:", status)
  if (body !== undefined) {
    await renderMdErr(jsonBlock(body), opts.raw)
  } else {
    await renderMdErr(codeBlock(message), opts.raw)
  }
}

async function pollBackgroundResponse(
  chat: Chat,
  model: { id: string; provider: string },
  displayOpts: DisplayOpts,
) {
  if (!chat.background) throw new Error("No background response to poll")

  const { id, startedAt, modelId, effort } = chat.background
  const apiKey = await getApiKey(model.provider, chat.profile)
  const showProgress = process.stdout.isTTY && !displayOpts.raw && !displayOpts.json
  const pb = showProgress ? $.progress("Waiting...") : null

  try {
    const startTime = startedAt.getTime()
    while (true) {
      const status = await gptBg.status(id, apiKey)
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
        ...(await gptBg.retrieve(id, resolveModel(modelId), apiKey)),
        effort,
      }
      const assistantMsg = makeAssMsg(model.id, startTime, response)
      chat.messages.push(assistantMsg)
      delete chat.background
      await renderResponse(assistantMsg, displayOpts)
    } else {
      const { status } = chat.background
      delete chat.background
      process.exitCode = 1
      console.log(`Background response ${status}`)
    }
  } finally {
    if (pb) pb.finish()
    if (showProgress) await bell()
  }
}

async function genResponse(chatInput: ChatInput, displayOpts: DisplayOpts = {}) {
  // don't want progress spinner when piping output
  const showProgress = process.stdout.isTTY && !displayOpts.raw && !displayOpts.json
  const label = chatInput.model.kind === "image" ? "Generating image..." : "Thinking..."
  const pb = showProgress ? $.progress(label) : null

  // Set up abort signal for non-background requests. Let's handle SIGTERM in
  // case it's relevant when this CLI gets called by another script.
  const abortController = new AbortController()
  const sigintHandler = () => abortController.abort()
  const sigtermHandler = () => abortController.abort()
  process.on("SIGINT", sigintHandler)
  process.on("SIGTERM", sigtermHandler)

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
    await renderError(e, displayOpts)
  } finally {
    process.off("SIGINT", sigintHandler)
    process.off("SIGTERM", sigtermHandler)
    if (pb) pb.finish() // otherwise it hangs around
    // terminal bell to indicate it's done
    if (showProgress) await bell()
  }
}

/**
 * The chat a prompt goes to and the model for it: a fresh chat, or for `-r`
 * the current one.
 */
function promptTarget(
  reply: boolean,
  modelArg: string | undefined,
  systemPrompt: string,
): { chat: Chat; model: Model } {
  if (!reply) return { chat: createChat(systemPrompt), model: resolveModel(modelArg) }

  const current = History.current()
  if (!current) throw new ValidationError("Can't reply: no chat in progress")
  if (current.background) {
    throw new ValidationError(
      "Current chat has a pending background response. Run `ai bg resume` or `ai bg cancel` before replying.",
    )
  }

  // -r uses same model as last response, but only if there is one and no model is specified
  const prevModelId = getLastModelId(current)
  const model = resolveModel(prevModelId && !modelArg ? prevModelId : modelArg)
  return { chat: current, model }
}

/** Pick a model for forking from a user message, starting on `defaultId` if given */
async function pickModel(defaultId: string | undefined) {
  const textModels = models.filter((m) => m.kind !== "image")
  const index = await selectIndex({
    message: "Pick a model to answer",
    options: textModels.map((m) => m.id),
    initialIndex: Math.max(
      0,
      textModels.findIndex((m) => m.id === defaultId),
    ),
  })
  return textModels[index]
}

/** Fork `chat` at a picked message into a new current chat */
async function forkChat(chat: Chat) {
  if (chat.messages.length === 0) throw new ValidationError("Chat has no messages")

  const selectedIdx = await selectIndex({
    message: "Pick a message to fork from",
    options: messagePickerOptions(chat.messages),
    // start on the latest answer so Enter continues it without asking for a model
    initialIndex: chat.messages.length - 1,
  })

  const selectedMessage = chat.messages[selectedIdx]
  const newChat: Chat = {
    ...createChat(chat.systemPrompt),
    messages: chat.messages.slice(0, selectedIdx + 1),
    summary: chat.summary,
    profile: chat.profile,
  }

  if (selectedMessage.role === "user") {
    // default to the model that originally answered this message
    const nextModel = chat.messages
      .slice(selectedIdx)
      .find((m) => m.role === "assistant")?.model
    const model = await pickModel(nextModel)
    newChat.profile = await resolveProfile(profileFlag(), chat.profile)
    const chatInput: ChatInput = {
      chat: newChat,
      model,
      apiKey: await getApiKey(model.provider, newChat.profile),
      config: { search: false, think: undefined },
    }
    await genResponse(chatInput, {})
  } else {
    console.log(`Forked after ${selectedMessage.model}. Continue with \`ai -r\`.`)
  }
  History.save(newChat, { current: true, touch: true })
}

/** Chat list where Enter resumes and letter keys show, fork, or delete */
async function historyPicker() {
  let initialIndex: number | undefined
  while (true) {
    const history = History.list()
    if (history.length === 0) {
      // we only get here after a delete if the user deleted everything
      if (initialIndex !== undefined) return
      throw new ValidationError("No chat history")
    }
    await genMissingSummaries(history, profileFlag())

    const chats = history.toReversed()
    const picked = await pickWithAction({
      message: "Chat history",
      options: chatPickerOptions(chats),
      initialIndex:
        initialIndex === undefined ? undefined : Math.min(initialIndex, chats.length - 1),
    })
    if (!picked) return
    const chat = chats[picked.index]

    switch (picked.action) {
      case "resume":
        History.touch(chat.id)
        return
      case "show":
        await renderMd(chatToMd({ chat, lastN: 1 }))
        return
      case "showAll":
        await renderMd(chatToMd({ chat, lastN: chat.messages.length }))
        return
      case "fork":
        await forkChat(chat)
        return
      case "delete": {
        const label = truncate(singleLine(chat.summary || "chat"), 60)
        if (await confirmed(`Delete "${label}"?`, { clear: true })) {
          History.delete([chat.id])
          console.log(`Deleted "${label}"`)
        }
        initialIndex = picked.index
      }
    }
  }
}

async function modelInfoMd(modelArg: string) {
  const model = resolveModel(modelArg)
  const { provider, key, id } = model

  const lines = [`**${id}** (${provider})`, `key: \`${key}\``]

  if (model.kind === "image") {
    if (provider === "openai") {
      lines.push(
        `image generation/editing: -i/--image, --quality ${imageQualities.join("|")}, --size WxH|auto`,
      )
    } else {
      lines.push(
        "image generation/editing: -i/--image, --size 1K|2K|4K (default 2K), --aspect W:H",
        "aspect ratios include 1:1, 3:2, 2:3, 4:3, 3:4, 5:4, 16:9, 9:16, 21:9, 4:1, 1:4, 8:1, 1:8",
        "without --aspect, the model chooses the ratio",
      )
    }
  } else if (searchProviders.has(provider)) {
    lines.push("search: yes")
  }

  const efforts = await thinkEfforts(model)
  if (efforts) {
    const flags = [
      ["--think", efforts.on],
      ["--think-hard", efforts.high],
      ["--quick", efforts.off],
    ]
      .filter(([, effort]) => effort !== efforts.default)
      .map(([flag, effort]) => `${flag} for ${effort}`)
    lines.push([`think: ${efforts.default} by default`, ...flags].join(", "))
  }

  if (model.kind === "image") {
    lines.push("output: PNG saved under ~/.local/state/llm-cli/images")
  }

  return lines.join("\n")
}

function exit(msg: string): never {
  console.log(msg)
  process.exit()
}

/** Commander option parser for integer values */
function parseInteger(value: string) {
  const n = Number(value)
  if (!Number.isInteger(n)) throw new InvalidArgumentError("Not an integer.")
  return n
}

/** Commander option parser for repeatable options */
const collect = (value: string, previous: string[] = []) => [...previous, value]

/** --profile, which subcommands only see through the root command */
const profileFlag = (): string | undefined => program.opts().profile

const program = new Command()
  .name("ai")
  .description(`Input from [message], stdin, or --image is required unless using a
command. If both message and stdin are present, stdin will be appended
to MESSAGE.`)
  .helpCommand(false)
  // subcommands copy these settings, so they get the same colors
  .configureHelp({
    styleTitle: bold,
    styleOptionText: blueBright,
    styleSubcommandText: blueBright,
    styleArgumentText: magentaBright,
  })
  .configureOutput({ outputError: (str, write) => write(red(str)) })
  .argument("[message...]", "Message to send to the LLM")
  .option("-r, --reply", "Continue existing chat")
  .option("-m, --model <model>", "Select model by substring (e.g., 'sonnet')")
  .option("-s, --search", "Enable web search (sticky: stays on for -r replies)")
  .option("--no-search", "Disable web search for this turn")
  .option("--think", "Enable thinking")
  .option("--think-hard", "Enable maximum thinking")
  .option("-q, --quick", "Minimize thinking")
  .option("--think-default", "Clear inherited thinking and use the model default")
  .option(
    "-i, --image <value>",
    "Image: URL, local file path, or 'clipboard' (macOS). Repeat for multiple images",
    collect,
  )
  .addOption(
    new Option("--quality <quality>", "Image quality (image models only)").choices(
      imageQualities,
    ),
  )
  .option(
    "--size <size>",
    "Image size: 1024x1536 or auto for OpenAI, 1K/2K/4K for Gemini (image models only)",
  )
  .option("--aspect <ratio>", "Aspect ratio, e.g. 16:9 (Gemini image models only)")
  .option("--system <system>", "Override entire system prompt")
  .option("-e, --ephemeral", "Don't save to history")
  .option("-b, --background", "Use background mode (OpenAI only)")
  .option("-v, --verbose", "Include reasoning in output")
  .option("--raw", "Print LLM text directly (no metadata or reasoning)")
  .addOption(
    new Option("--json", "Print the full response message as JSON (for scripts)").conflicts(
      ["raw", "verbose"],
    ),
  )
  .option("-o, --output-schema <schema>", "ArkType schema for structured output")
  .option("--profile <name>", "API key profile (see `ai profiles`)")
  .addHelpText(
    "after",
    `
Examples:
  ai 'What is the capital of France?'
  cat main.ts | ai 'what is this?'
  echo 'what are you?' | ai
  ai -r 'elaborate on that'
  ai -m 4o 'What are generic types?'
  ai -o '{ urgent: "boolean", reason: "string" }' 'is this urgent? server is down'
  ai gist -t 'Generic types'
  ai -m flare --quality low 'a lighthouse at dusk'
  ai -m banana --size 2K --aspect 16:9 'a lighthouse at dusk'
  ai -m banana -i photo.png 'make it sunset'
  ai -i first.png -i second.jpg 'Compare these images'`,
  )
  .action(async (message, opts) => {
    let outputSchema
    if (opts.outputSchema) {
      // arktype takes ~70 ms to load, so only load it when it's needed
      const { parseType } = await import("./schema.ts")
      try {
        outputSchema = parseType(opts.outputSchema)
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e))
        process.exit(1)
      }
    }

    const imageInputs = opts.image ?? []
    const hasImages = imageInputs.length > 0
    const msg = message.join(" ")
    const piped = !process.stdin.isTTY
    const stdin = piped ? (await text(process.stdin)).trim() : null

    // Empty piped input usually means the upstream command failed (e.g.,
    // `cb x | ai ...` when `cb` errors). Fail rather than sending only `msg`.
    if (piped && !stdin && !hasImages) {
      throw new ValidationError("Piped input was empty (did an upstream command fail?)")
    }

    if (!msg && !stdin && !hasImages) {
      throw new ValidationError("Message, stdin, image, or command is required")
    }
    const input = [stdin, msg].filter(Boolean).join("\n\n")

    const displayOpts = pick(opts, ["raw", "verbose", "json"])
    const { chat, model } = promptTarget(
      !!opts.reply,
      opts.model,
      opts.system || systemBase,
    )

    const thinkOverride: ThinkOverride = opts.quick
      ? "off"
      : opts.thinkHard
        ? "high"
        : opts.think
          ? "on"
          : opts.thinkDefault
            ? "default"
            : undefined
    // Search is sticky across replies so tool definitions stay stable for
    // prompt caching (see Chat.search in types.ts).
    chat.search = opts.search ?? chat.search ?? false
    chat.think = resolveThink(thinkOverride, chat.think)
    // An explicit --profile or LLM_CLI_PROFILE wins over the chat's, and sticks
    // for later replies
    chat.profile = await resolveProfile(opts.profile, chat.profile)
    const chatInput: ChatInput = {
      chat,
      model,
      apiKey: await getApiKey(model.provider, chat.profile),
      config: { search: chat.search, think: chat.think },
      outputSchema,
      imageOptions: { quality: opts.quality, size: opts.size, aspect: opts.aspect },
    }

    const problems = requestProblems(model, {
      reply: !!opts.reply,
      hasPreviousImage: chat.messages.some(
        (m) => m.role === "assistant" && Boolean(m.images?.length),
      ),
      system: opts.system !== undefined,
      images: hasImages,
      prompt: input.trim().length > 0,
      config: chatInput.config,
      outputSchema: !!outputSchema,
      background: !!opts.background,
      quality: opts.quality,
      size: opts.size,
      aspect: opts.aspect,
    })
    if (problems.length > 0) throw new ValidationError(problems.join("\n"))

    const image_urls = hasImages
      ? await Promise.all(imageInputs.map((value) => resolveImage(value)))
      : undefined

    chat.messages.push({
      role: "user",
      content: input,
      createdAt: new Date(),
      image_urls,
      outputSchema: outputSchema?.expression,
    })

    if (opts.background) {
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
        await pollBackgroundResponse(chat, model, displayOpts)
      } catch (e: unknown) {
        await renderError(e, displayOpts)
      }
    } else {
      await genResponse(chatInput, displayOpts)
    }

    if (!opts.ephemeral) History.save(chat, { current: true, touch: true })
  })

program
  .command("show")
  .description("Show chat so far (last N, default 1)")
  .option("-a, --all", "Show all messages")
  .option("-n, --limit <n>", "Number of messages", parseInteger, 1)
  .option("-p, --pick <spec>", "Pick specific messages (e.g., '1,3-4,7', 'even', 'odd')")
  .option("-v, --verbose", "Include reasoning in output")
  .option("--raw", "Print LLM output directly (no metadata or reasoning)")
  // The root command has -v and --raw too, and Commander gives them to it
  .action(async (_, cmd) => {
    const opts = cmd.optsWithGlobals()
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

const historyCmd = program
  .command("history")
  .description("Browse recent chats: resume, show, fork, or delete")
  .action(historyPicker)

historyCmd
  .command("delete")
  .description("Pick recent chats to delete")
  .action(async () => {
    const history = History.list()
    await genMissingSummaries(history, profileFlag())
    if (history.length === 0) throw new ValidationError("No chat history")

    const reversed = history.toReversed()
    const selected = await selectIndexes({
      message: "Pick chats to delete",
      options: chatPickerOptions(reversed),
    })
    if (selected.length === 0) return
    const label = `${selected.length} chat${selected.length === 1 ? "" : "s"}`
    if (!(await confirmed(`Delete ${label}?`))) return
    History.delete(selected.map((i) => reversed[i].id))
    console.log(`Deleted ${label}`)
  })

historyCmd
  .command("clear")
  .description("Delete saved chat history")
  .action(async () => {
    const history = History.list()
    const n = history.length
    if (!(await confirmed(`Delete ${n} chats?`))) return
    History.clear()
    console.log("Deleted chat history")
  })

program
  .command("gist")
  .description("Save chat to GitHub Gist with gh CLI")
  .option("-t, --title <title>", "Gist title")
  .option("-a, --all", "Include all messages")
  .option("-n, --limit <n>", "Number of messages", parseInteger, 1)
  .option("-p, --pick <spec>", "Pick specific messages (e.g., '1,3-4,7', 'even', 'odd')")
  .option("--id <id>", "Replace contents of an existing gist by ID")
  .action(async (opts) => {
    const lastChat = History.current()
    if (!lastChat) throw new ValidationError("No chat in progress")

    if (!$.commandExistsSync("gh")) {
      throw new Error("Creating a gist requires the `gh` CLI (https://cli.github.com/)")
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
      if (!opts.title) await genMissingSummaries([lastChat], profileFlag())
      const title = opts.title || lastChat.summary
      const filename = title ? `LLM chat - ${title}.md` : "LLM chat.md"
      await $`gh gist create -f ${filename} --web`.stdinText(md)
    }
  })

program
  .command("models")
  .description("List models or show info for a specific model")
  .argument("[model]", "Model key or substring")
  .option("-v, --verbose", "Show model keys")
  // like show, -v goes to the root command
  .action(async (modelArg, _, cmd) => {
    if (modelArg) {
      await renderMd(await modelInfoMd(modelArg))
    } else {
      await renderMd(modelsMd(cmd.optsWithGlobals().verbose))
    }
  })

program
  .command("profiles")
  .description("Show API key profiles, creating the config file if needed")
  .action(async () => {
    if (ensureConfigFile()) console.log("Created config file")
    console.log(await profilesReport(profileFlag()))
  })

const bgCmd = program.command("bg").description("Manage background responses")

bgCmd
  .command("status")
  .description("Check status of current chat's background request")
  .action(async () => {
    const chat = History.findLatestBackground()
    if (!chat?.background) exit("No background task found")

    const profile = await resolveProfile(profileFlag(), chat.profile)
    const status = await gptBg.status(
      chat.background.id,
      await getApiKey(chat.background.provider, profile),
    )
    const elapsed = Date.now() - chat.background.startedAt.getTime()
    console.log(`${formatElapsed(elapsed)} (${status})`)
  })

bgCmd
  .command("resume")
  .description("Resume polling for current chat's background request")
  .action(async () => {
    const chat = History.findLatestBackground()
    if (!chat?.background) exit("No background task found")

    const model = { id: chat.background.modelId, provider: chat.background.provider }
    chat.profile = await resolveProfile(profileFlag(), chat.profile)
    await pollBackgroundResponse(chat, model, {})
    History.save(chat)
  })

bgCmd
  .command("cancel")
  .description("Cancel current chat's background request")
  .action(async () => {
    const chat = History.findLatestBackground()
    if (!chat?.background) exit("No background task found")

    const profile = await resolveProfile(profileFlag(), chat.profile)
    await gptBg.cancel(
      chat.background.id,
      await getApiKey(chat.background.provider, profile),
    )
    delete chat.background
    History.save(chat)
    console.log("Background response cancelled")
  })

try {
  await program.parseAsync()
} catch (e) {
  if (e instanceof ValidationError) program.error(`error: ${e.message}`)
  throw e
}
