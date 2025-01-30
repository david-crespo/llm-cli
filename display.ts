import $ from "jsr:@david/dax@0.42"
import { markdownTable } from "https://esm.sh/markdown-table@3.0.4"

import { Chat, type ChatMessage } from "./types.ts"
import { defaultModel, models } from "./models.ts"

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
  ["Nickname", "Model", "Input", "Cached", "Output"],
  ...models
    .map((m) => [
      m.nickname + (m.key === defaultModel ? " ⭐" : ""),
      m.key,
      moneyFmt.format(m.input),
      m.input_cached ? moneyFmt.format(m.input_cached) : "",
      moneyFmt.format(m.output),
    ]),
])

export const modelsMd =
  `Models are matched on key or nickname. Prices are per million tokens.\n\n${modelsTable}`

// split from message content because we only want this in show or gist mode
function messageHeaderMd(msg: ChatMessage, msgNum: number, msgCount: number) {
  return `# ${msg.role} (${msgNum}/${msgCount})\n\n`
}

const timeFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

export function messageContentMd(msg: ChatMessage, raw = false) {
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
  if (!raw) output += "\n\n"
  return output
}

export function chatToMd(chat: Chat, lastN: number = 0): string {
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

export const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})
