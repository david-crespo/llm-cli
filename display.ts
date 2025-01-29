import $ from "jsr:@david/dax@0.42"
import { markdownTable } from "https://esm.sh/markdown-table@3.0.4"

import { Chat, type ChatMessage } from "./types.ts"
import { defaultModel, M, models } from "./models.ts"

const RENDERER = "glow"

export async function renderMd(md: string, raw = false) {
  if ($.commandExistsSync(RENDERER) && Deno.stdout.isTerminal() && !raw) {
    await $`${RENDERER}`.stdinText(md)
  } else {
    console.log(md)
  }
}

export async function printError(msg: string) {
  await renderMd(`⚠️  ${msg}`)
}

export const codeBlock = (contents: string, lang = "") =>
  `\`\`\`${lang}\n${contents}\n\`\`\`\n`
export const jsonBlock = (obj: unknown) => codeBlock(JSON.stringify(obj, null, 2), "json")

const codeMd = (s: string) => `\`${s}\``
export const codeListMd = (strs: string[]) => strs.map(codeMd).join(", ")

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

export const modelsMd = `# Models\n\n${modelsTable}`

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
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
})

export function padMiddle(s1: string, s2: string, width: number) {
  const len1 = s1.length
  const len2 = s2.length
  if (len1 + len2 >= width - 1) return s1 + " " + s2
  const padding = ".".repeat(width - len1 - len2)
  return s1 + padding + s2
}
