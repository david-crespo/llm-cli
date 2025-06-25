import $ from "jsr:@david/dax@0.42"
import { markdownTable } from "https://esm.sh/markdown-table@3.0.4"

import { Chat, type ChatMessage } from "./types.ts"
import { models, systemBase } from "./models.ts"

const RENDERER = "glow"

export async function renderMd(md: string, raw = false) {
  if ($.commandExistsSync(RENDERER) && Deno.stdout.isTerminal() && !raw) {
    await $`${RENDERER}`.stdinText(md)
  } else {
    console.log(md)
  }
}

export const codeBlock = (contents: string, lang = "") =>
  `\`\`\`${lang}\n${contents}\n\`\`\`\n`
export const jsonBlock = (obj: unknown) => codeBlock(JSON.stringify(obj, null, 2), "json")

const codeMd = (s: string) => `\`${s}\``
export const codeListMd = (strs: string[]) => strs.map(codeMd).join(", ")

const moneyFmt = Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 5,
})

const modelsTable = markdownTable([
  ["ID", "Model key", "Input", "Cached", "Output"],
  ...models
    .map((m) => [
      m.id + (m.default ? " ⭐" : ""),
      m.key.replace(/^meta-llama\//, ""),
      moneyFmt.format(m.input),
      m.input_cached ? moneyFmt.format(m.input_cached) : "",
      moneyFmt.format(m.output),
    ]),
])

/** Split, add `"> "` to the beginning of each line, and rejoin */
const quote = (s: string) => s.split("\n").map((line) => "> " + line).join("\n")

export const modelsMd =
  `Models are matched on ID or key. Prices are per million tokens.\n\n${modelsTable}`

// split from message content because we only want this in show or gist mode
function messageHeaderMd(msg: ChatMessage, msgNum: number, msgCount: number) {
  return `# ${msg.role} (${msgNum}/${msgCount})\n\n`
}

const timeFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

const escapeThinkTags = (content: string) =>
  content
    .replace("<think>", "\\<think>")
    .replace("</think>", "\\</think>")

// TODO: add `verbose` mode and hide reasoning from `nice` mode

/**
 * - `cli` is the default show output, includes meta but not reasoning
 * - `verbose` is like `cli` + reasoning
 * - `raw` is for insertion in, e.g., a text editor
 * - `gist` includes meta but collapses reasoning under `<details>`
 */
type DisplayMode = "cli" | "verbose" | "raw" | "gist"

export function messageContentMd(msg: ChatMessage, mode: DisplayMode) {
  let output = ""

  if (msg.role === "assistant") {
    // show metadata line in all modes except raw
    if (mode !== "raw") {
      // only show stop reason if it's not a natural stop
      const showStopReason = !["stop", "end_turn", "completed"].includes(
        msg.stop_reason.toLowerCase(),
      )

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

    // only show reasoning in gist or verbose mode
    if (msg.reasoning) {
      if (mode === "gist") {
        output += tag("details", tag("summary", "Reasoning"), quote(msg.reasoning))
      } else if (mode === "verbose") {
        output += quote(msg.reasoning) + "\n\n"
      }
    }
  }

  output += mode === "raw" ? msg.content : escapeThinkTags(msg.content)
  if (msg.role === "user" && msg.image_url) {
    output += `\n\n[Image](${msg.image_url})`
  }
  if (mode !== "raw") output += "\n\n"
  return output
}

type ChatToMd = { chat: Chat; lastN?: number; mode?: DisplayMode }

const tag = (t: string, ...children: string[]) =>
  `<${t}>\n${children.join("\n")}\n</${t}>\n\n`

export function chatToMd({ chat, lastN = 0, mode = "cli" }: ChatToMd): string {
  const messages = lastN ? chat.messages.slice(-lastN) : chat.messages

  if (mode === "raw") {
    return messages.map((msg) => messageContentMd(msg, "raw")).join("\n\n")
  }

  let output = `**Chat started:** ${longDateFmt.format(chat.createdAt)}\n\n`

  // only print system prompt if it's non-default
  if (mode === "gist" || chat.systemPrompt !== systemBase) {
    output += tag("details", tag("summary", "System prompt"), chat.systemPrompt)
  }

  const msgCount = chat.messages.length
  const skippedCount = msgCount - lastN
  messages.forEach((msg, i) => {
    output += messageHeaderMd(msg, skippedCount + i + 1, msgCount)
    output += messageContentMd(msg, mode)
  })
  return output
}

export const longDateFmt = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
})

export const shortDateFmt = new Intl.DateTimeFormat("en-US", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})
