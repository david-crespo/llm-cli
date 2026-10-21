//
// markdown-exit plugin that renders to ANSI-styled terminal output.
// Install with md.use(terminalPlugin), then call md.renderAsync(src, env).
// Post-processing (links, tables, paragraph wrapping, blockquotes) is handled
// automatically by wrapping renderAsync.

import type { MarkdownExit, RenderRule, Token } from "markdown-exit"
import process from "node:process"
import ansis, {
  blue,
  bold,
  cyan,
  dim,
  gray,
  green,
  italic,
  strikethrough,
  white,
} from "ansis"
import stringWidth from "string-width"
import supportsHyperlinks from "supports-hyperlinks"
import wrapAnsi from "wrap-ansi"
import mathPlugin, { type MathEnv, restoreMath } from "./terminal-math.ts"

const { fg } = ansis

// --- Styling -----------------------------------------------------------

export const h1 = white.bg(63).bold
export const h2 = blue.bold
export const codespan = fg(203).bg(236)
const tableBorder = gray
const tableHeader = cyan.bold

const SGR_RE = /\x1b\[[0-9;]*m/g
// Drops the scheme linkify adds, so example.com and b@c.co match their hrefs
const bareUrl = (s: string) => s.replace(/^(https?:\/\/|mailto:)/, "")

function hyperlink(url: string, text: string): string {
  if (!supportsHyperlinks.stdout) {
    // Autolinks already show the URL as their text
    if (bareUrl(url) === bareUrl(text.replace(SGR_RE, ""))) return blue(text)
    return `${blue(text)} (${dim(url)})`
  }
  return `\x1b]8;;${url}\x07${blue(text)}\x1b]8;;\x07`
}

// --- Reflow ------------------------------------------------------------

const reflowText = (text: string, maxWidth: number): string =>
  maxWidth <= 0 ? text : wrapAnsi(text, maxWidth)

// --- Table renderer ----------------------------------------------------

type Align = "left" | "right" | "center"

function align(s: string, w: number, how: Align | undefined): string {
  const space = w - stringWidth(s)
  if (how === "right") return " ".repeat(space) + s
  if (how === "center") {
    const left = Math.floor(space / 2)
    return " ".repeat(left) + s + " ".repeat(space - left)
  }
  return s + " ".repeat(space)
}

/**
 * Shrink column widths to fit `budget`. Columns narrower than an even share of
 * what's left keep their width, and the rest split the remainder.
 */
function fitWidths(natural: number[], budget: number): number[] {
  const total = natural.reduce((a, b) => a + b, 0)
  if (total <= budget || budget < 3 * natural.length) return natural
  const widths = [...natural]
  let remaining = budget
  const narrowestFirst = natural.map((_, c) => c).sort((a, b) => natural[a] - natural[b])
  for (const [k, c] of narrowestFirst.entries()) {
    const share = Math.floor(remaining / (natural.length - k))
    widths[c] = Math.max(3, Math.min(natural[c], share))
    remaining -= widths[c]
  }
  return widths
}

function renderTable(
  rows: string[][],
  headerCount: number,
  aligns: Align[],
  maxWidth: number,
): string {
  if (rows.length === 0) return ""

  const cols = Math.max(...rows.map((r) => r.length))
  const natural = Array.from({ length: cols }, (_, c) =>
    Math.max(3, ...rows.map((r) => stringWidth(r[c] ?? ""))),
  )
  // Each column takes 3 for its padding and left border, plus 1 for the right
  const widths = fitWidths(natural, maxWidth - 3 * cols - 1)

  const rule = (l: string, m: string, r: string) =>
    tableBorder(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r)
  const line = (cells: string[], isHeader: boolean) =>
    tableBorder("│ ") +
    widths
      .map((w, c) => {
        const p = align(cells[c] ?? "", w, aligns[c])
        return isHeader ? tableHeader(p) : p
      })
      .join(tableBorder(" │ ")) +
    tableBorder(" │")
  // A row whose cells wrap spans several lines
  const row = (cells: string[], isHeader: boolean) => {
    const wrapped = widths.map((w, c) => {
      const cell = cells[c] ?? ""
      return stringWidth(cell) > w ? wrapAnsi(cell, w, { hard: true }).split("\n") : [cell]
    })
    const height = Math.max(...wrapped.map((l) => l.length))
    return Array.from({ length: height }, (_, i) =>
      line(
        wrapped.map((l) => l[i] ?? ""),
        isHeader,
      ),
    )
  }

  return [
    rule("╭", "┬", "╮"),
    ...rows.flatMap((cells, r) => [
      ...row(cells, r < headerCount),
      ...(r === headerCount - 1 ? [rule("├", "┼", "┤")] : []),
    ]),
    rule("╰", "┴", "╯"),
  ].join("\n")
}

// --- State for block-level tracking ------------------------------------

// The list items and blockquotes around the current block, innermost last,
// with the columns each takes from the width
type Container = { kind: "item" | "quote"; width: number }

type RenderState = {
  containers: Container[]
  listDepth: number
  listOrdered: boolean[]
  listCounters: number[]
  listNumberWidths: number[]
  listItemBlocks: number[]
  listItemPrefixes: string[]
  listItemDone: boolean[]
  blockquoteDepth: number
}

function freshState(): RenderState {
  return {
    containers: [],
    listDepth: 0,
    listOrdered: [],
    listCounters: [],
    listNumberWidths: [],
    listItemBlocks: [],
    listItemPrefixes: [],
    listItemDone: [],
    blockquoteDepth: 0,
  }
}

// oxlint-disable-next-line typescript/no-explicit-any
function getState(env: any): RenderState {
  if (!env._termState) env._termState = freshState()
  return env._termState
}

const inListItem = (s: RenderState) => s.containers.at(-1)?.kind === "item"

/** Columns left for a block after the prefixes of the containers around it. */
const availableWidth = (s: RenderState) =>
  getWidth() - s.containers.reduce((sum, c) => sum + c.width, 0)

const isListClose = (token: Token | undefined) =>
  token?.type === "bullet_list_close" || token?.type === "ordered_list_close"

/**
 * Count a block directly inside a list item, and return the line break and
 * indent it starts with. The first block goes on the bullet's line, later ones
 * on a new line at the item's indent. A block that indents its own lines
 * (`ownLines`, like a code block or table) only gets the line break. A nested
 * list already ends its line, so a block after one gets no extra break.
 */
function startListBlock(
  s: RenderState,
  tokens: Token[],
  idx: number,
  ownLines: boolean,
): string {
  const i = s.listItemBlocks.length - 1
  const first = s.listItemBlocks[i] === 0
  s.listItemBlocks[i]++
  const indent = ownLines ? "" : (s.listItemPrefixes.at(-1) ?? "")
  if (isListClose(tokens[idx - 1])) return indent
  return first && !ownLines ? "" : "\n" + indent
}

// --- Lists -------------------------------------------------------------

/** Count the items of the list that opens at `idx`, not counting nested ones. */
function countItems(tokens: Token[], idx: number): number {
  const level = tokens[idx].level
  let count = 0
  for (let i = idx + 1; i < tokens.length && tokens[i].level > level; i++) {
    if (tokens[i].type === "list_item_open" && tokens[i].level === level + 1) count++
  }
  return count
}

// --- Task lists --------------------------------------------------------

/**
 * If the list item at `idx` starts with `[ ] ` or `[x] `, strip that from its
 * text and return whether it's checked.
 */
function takeTaskMarker(tokens: Token[], idx: number): boolean | undefined {
  if (tokens[idx + 1]?.type !== "paragraph_open") return undefined
  const first = tokens[idx + 2]?.children?.[0]
  const match = first?.type === "text" && first.content.match(/^\[([ xX])\] /)
  if (!first || !match) return undefined
  first.content = first.content.slice(match[0].length)
  return match[1] !== " "
}

// --- Code highlighting -------------------------------------------------

async function highlightCode(
  code: string,
  lang: string,
  indent: string,
  theme = "ayu-mirage",
) {
  const codeToANSI = await import("@shikijs/cli")
    .then((m) => m.codeToANSI)
    .catch(() => undefined)
  let highlighted: string
  try {
    // @ts-expect-error lang/theme are arbitrary strings, not BundledLanguage/BundledTheme
    highlighted = codeToANSI ? await codeToANSI(code, lang, theme) : code
  } catch {
    highlighted = code
  }
  // Shiki ends its output with a newline
  return highlighted
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => indent + l)
    .join("\n")
}

// Inside a list item, a code block starts on its own line under the item text
// and leaves the line break after it to list_item_close.
function renderCodeBlock(
  code: string,
  lang: string,
  tokens: Token[],
  idx: number,
  // oxlint-disable-next-line typescript/no-explicit-any
  env: any,
): Promise<string> {
  const s = getState(env)
  if (!inListItem(s)) {
    return highlightCode(code, lang, "  ", env.codeTheme).then((c) => c + "\n\n")
  }
  const start = startListBlock(s, tokens, idx, true)
  const indent = (s.listItemPrefixes.at(-1) ?? "") + "  "
  return highlightCode(code, lang, indent, env.codeTheme).then((c) => start + c)
}

// --- Post-processing ---------------------------------------------------

function postProcessLinks(text: string): string {
  return text.replace(/\x00LINK:(.*?)\x00([\s\S]*?)\x00\/LINK\x00/g, (_, href, linkText) =>
    hyperlink(href, linkText),
  )
}

// Styling the whole heading with an ansis call, rather than emitting open and
// close codes around it, reopens the heading style after any inline style
// inside it closes (a codespan's close would otherwise end the heading color).
function postProcessHeadings(text: string): string {
  return text.replace(
    /\x00H:(\d)\x00([\s\S]*?)\x00\/H\x00/g,
    (_, level: string, content: string) => (level === "1" ? h1 : h2)(content),
  )
}

// Paragraphs inside blockquotes arrive already wrapped to leave room for the
// prefixes, so this only adds them. The marker carries the indent of a list
// item the quote is in, and whether to leave the line break after it to the
// item.
function postProcessBlockquotes(text: string): string {
  let maxDepth = 0
  for (const [, depth] of text.matchAll(/\x00BQ_OPEN:(\d+):/g)) {
    maxDepth = Math.max(maxDepth, Number(depth))
  }

  let result = text
  for (let depth = maxDepth; depth > 0; depth--) {
    result = result.replace(
      new RegExp(
        `\x00BQ_OPEN:${depth}:(\\d+):(\\d)\x00([\\s\\S]*?)\x00BQ_CLOSE:${depth}\x00`,
        "g",
      ),
      (_, indent: string, inItem: string, content: string) => {
        const prefix = " ".repeat(Number(indent)) + gray(" │ ")
        const blankPrefix = " ".repeat(Number(indent)) + gray(" │")
        const paragraphs = content.split("\x00BQ_PARA\x00").filter((p) => p.trim())
        const prefixed = paragraphs.map((p) =>
          p
            .trimEnd()
            .split("\n")
            .map((l) => (l ? prefix + l : blankPrefix))
            .join("\n"),
        )
        return prefixed.join("\n" + blankPrefix + "\n") + (inItem === "1" ? "" : "\n\n")
      },
    )
  }
  return result
}

function postProcessTables(text: string): string {
  const cellRe = /\x00CELL:(\w*)\x00([\s\S]*?)\x00\/CELL\x00/g
  const extractCells = (row: string) => [...row.matchAll(cellRe)].map((m) => m[2].trim())

  // The marker carries the width, the indent of a list item the table is in,
  // and whether to leave the line break after it to the item
  const tableRe = /\x00TABLE:(\d+):(\d+):(\d)\x00([\s\S]*?)\x00\/TABLE\x00/g
  return text.replace(
    tableRe,
    (_, width: string, indent: string, inItem: string, content: string) => {
      const rows = [...content.matchAll(/\x00TR\x00([\s\S]*?)\x00\/TR\x00/g)].map((m) =>
        extractCells(m[1]),
      )
      const thead = content.match(/\x00THEAD\x00([\s\S]*?)\x00\/THEAD\x00/)
      const headerRows = thead ? [...thead[1].matchAll(/\x00TR\x00/g)].length : 0
      // markdown-it gives every cell its column's alignment
      const firstRow = content.match(/\x00TR\x00([\s\S]*?)\x00\/TR\x00/)?.[1] ?? ""
      const aligns = [...firstRow.matchAll(cellRe)].map((m) => (m[1] || undefined) as Align)
      const table = renderTable(rows, headerRows, aligns, Number(width))
      const pad = " ".repeat(Number(indent))
      return pad + table.replaceAll("\n", "\n" + pad) + (inItem === "1" ? "" : "\n\n")
    },
  )
}

const cellOpen = (token: Token) =>
  `\x00CELL:${token.attrGet("style")?.match(/text-align:(\w+)/)?.[1] ?? ""}\x00`

// Paragraphs carry their wrap width, hanging indent and style flags in the
// marker, since all depend on list and blockquote nesting known only at render
// time. Flags: d = dim (a done task), i = italic (in a blockquote, where only
// paragraphs are italic, not code or tables). As with headings, applying the style as
// an ansis call keeps it on across inline styles that close inside.
function postProcessParagraphs(text: string): string {
  return text.replace(
    /\x00P:(\d+):(\d+):(\w*)\x00([\s\S]*?)\x00\/P\x00/g,
    (_, width: string, indent: string, flags: string, content: string) => {
      if (flags.includes("i")) content = italic(content)
      if (flags.includes("d")) content = dim(content)
      return reflowText(content, Number(width)).replaceAll(
        "\n",
        "\n" + " ".repeat(Number(indent)),
      )
    },
  )
}

// --- Plugin ------------------------------------------------------------

// C0 and C1 controls other than tab, newline and CR (which markdown-it turns
// into newlines). Model output can echo untrusted text, and these would reach
// the terminal as escape sequences (clearing the screen, rewriting earlier
// lines, setting the title). NUL is also our marker delimiter.
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g

export type TerminalEnv = MathEnv & { codeTheme?: string }

function getColumns(): number {
  return process.stdout.columns ?? 80
}

function getWidth(): number {
  return Math.min(getColumns(), 100)
}

export default function terminalPlugin(md: MarkdownExit): void {
  md.use(mathPlugin)
  const rules: Record<string, RenderRule> = {
    // Inline
    text: (tokens, idx) => tokens[idx].content,
    // Pad and replace internal spaces with NBSP so wrap-ansi treats the
    // codespan as a single unbreakable word. Splitting inside a styled span
    // either leaks bg color to the end of the line (BCE) or leaves a lone
    // styled space stranded on the previous line. renderAsync turns them back
    // into spaces once everything is wrapped, so copied code pastes intact.
    code_inline: (tokens, idx) => codespan(` ${tokens[idx].content.replace(/ /g, " ")} `),
    strong_open: () => bold.open,
    strong_close: () => bold.close,
    em_open: () => italic.open,
    em_close: () => italic.close,
    s_open: () => strikethrough.open,
    s_close: () => strikethrough.close,
    softbreak: () => "\n",
    hardbreak: () => "\n",
    html_inline: (tokens, idx) => dim(tokens[idx].content),
    html_block: (tokens, idx) => dim(tokens[idx].content) + "\n",
    link_open: (tokens, idx) => `\x00LINK:${tokens[idx].attrGet("href") ?? ""}\x00`,
    link_close: () => "\x00/LINK\x00",
    image: (tokens, idx) => {
      const src = tokens[idx].attrGet("src") ?? ""
      const alt = tokens[idx].content || tokens[idx].children?.[0]?.content || "image"
      return dim(`![${alt}](${src})`)
    },

    // Block
    heading_open: (tokens, idx, _options, env) => {
      const s = getState(env)
      const start = inListItem(s) ? startListBlock(s, tokens, idx, false) : ""
      const level = parseInt(tokens[idx].tag.slice(1))
      return `${start}\x00H:${level}\x00${"#".repeat(level)} `
    },
    heading_close: (_tokens, _idx, _options, env) =>
      "\x00/H\x00" + (inListItem(getState(env)) ? "" : "\n\n"),
    paragraph_open: (tokens, idx, _options, env) => {
      const s = getState(env)
      const inItem = inListItem(s)
      const start = inItem ? startListBlock(s, tokens, idx, false) : ""
      const indent = inItem ? (s.listItemPrefixes.at(-1) ?? "").length : 0
      const flags = (s.listItemDone.at(-1) ? "d" : "") + (s.blockquoteDepth > 0 ? "i" : "")
      return `${start}\x00P:${availableWidth(s)}:${indent}:${flags}\x00`
    },
    paragraph_close: (_tokens, _idx, _options, env) => {
      const s = getState(env)
      if (inListItem(s)) return "\x00/P\x00"
      if (s.containers.at(-1)?.kind === "quote") return "\x00/P\x00\x00BQ_PARA\x00"
      return "\x00/P\x00\n\n"
    },
    hr: (tokens, idx, _options, env) => {
      const s = getState(env)
      const rule = gray("─".repeat(availableWidth(s)))
      return inListItem(s) ? startListBlock(s, tokens, idx, false) + rule : rule + "\n\n"
    },
    blockquote_open: (tokens, idx, _options, env) => {
      const s = getState(env)
      const inItem = inListItem(s)
      const start = inItem ? startListBlock(s, tokens, idx, true) : ""
      const indent = inItem ? (s.listItemPrefixes.at(-1) ?? "").length : 0
      s.blockquoteDepth++
      s.containers.push({ kind: "quote", width: 3 })
      return `${start}\x00BQ_OPEN:${s.blockquoteDepth}:${indent}:${inItem ? 1 : 0}\x00`
    },
    blockquote_close: (_tokens, _idx, _options, env) => {
      const s = getState(env)
      const marker = `\x00BQ_CLOSE:${s.blockquoteDepth}\x00`
      s.blockquoteDepth--
      s.containers.pop()
      return marker
    },

    // Lists
    bullet_list_open: (tokens, idx, _options, env) => {
      const s = getState(env)
      s.listDepth++
      s.listOrdered.push(false)
      s.listCounters.push(0)
      s.listNumberWidths.push(0)
      return inListItem(s) ? startListBlock(s, tokens, idx, true) : ""
    },
    bullet_list_close: (_tokens, _idx, _options, env) => {
      const s = getState(env)
      s.listDepth--
      s.listOrdered.pop()
      s.listCounters.pop()
      s.listNumberWidths.pop()
      return inListItem(s) ? "" : "\n"
    },
    ordered_list_open: (tokens, idx, _options, env) => {
      const s = getState(env)
      s.listDepth++
      s.listOrdered.push(true)
      const start = parseInt(tokens[idx].attrGet("start") ?? "1")
      s.listCounters.push(start - 1)
      s.listNumberWidths.push(String(start + countItems(tokens, idx) - 1).length)
      return inListItem(s) ? startListBlock(s, tokens, idx, true) : ""
    },
    ordered_list_close: (_tokens, _idx, _options, env) => {
      const s = getState(env)
      s.listDepth--
      s.listOrdered.pop()
      s.listCounters.pop()
      s.listNumberWidths.pop()
      return inListItem(s) ? "" : "\n"
    },
    list_item_open: (tokens, idx, _options, env) => {
      const s = getState(env)
      // Nested lists line up under their parent item's text
      const indent = inListItem(s) ? (s.listItemPrefixes.at(-1) ?? "") : ""
      const isOrdered = s.listOrdered[s.listOrdered.length - 1]
      const checked = isOrdered ? undefined : takeTaskMarker(tokens, idx)
      let marker: string
      if (isOrdered) {
        const counter = ++s.listCounters[s.listCounters.length - 1]
        marker = `${String(counter).padStart(s.listNumberWidths.at(-1) ?? 0)}.`
      } else if (checked !== undefined) {
        marker = checked ? green("[x]") : dim("[") + " " + dim("]")
      } else {
        marker = "*"
      }
      s.listItemBlocks.push(0)
      s.listItemPrefixes.push(" ".repeat(indent.length + stringWidth(marker) + 1))
      s.listItemDone.push(checked === true)
      s.containers.push({ kind: "item", width: stringWidth(marker) + 1 })
      return `${indent}${marker} `
    },
    list_item_close: (tokens, idx, _options, env) => {
      const s = getState(env)
      s.listItemBlocks.pop()
      s.listItemPrefixes.pop()
      s.listItemDone.pop()
      s.containers.pop()
      return isListClose(tokens[idx - 1]) ? "" : "\n"
    },

    // Tables — markers assembled in post-processing
    table_open: (tokens, idx, _options, env) => {
      const s = getState(env)
      const inItem = inListItem(s)
      const start = inItem ? startListBlock(s, tokens, idx, true) : ""
      const indent = inItem ? (s.listItemPrefixes.at(-1) ?? "").length : 0
      return `${start}\x00TABLE:${availableWidth(s) - indent}:${indent}:${inItem ? 1 : 0}\x00`
    },
    table_close: () => "\x00/TABLE\x00",
    thead_open: () => "\x00THEAD\x00",
    thead_close: () => "\x00/THEAD\x00",
    tbody_open: () => "",
    tbody_close: () => "",
    tr_open: () => "\x00TR\x00",
    tr_close: () => "\x00/TR\x00",
    th_open: (tokens, idx) => cellOpen(tokens[idx]),
    th_close: () => "\x00/CELL\x00",
    td_open: (tokens, idx) => cellOpen(tokens[idx]),
    td_close: () => "\x00/CELL\x00",

    // Code blocks — async, handled by renderAsync
    fence: (tokens, idx, _options, env) => {
      const token = tokens[idx]
      const lang = token.info.trim().split(/\s+/)[0] || "text"
      const code = token.content.replace(/\n$/, "")
      return renderCodeBlock(code, lang, tokens, idx, env)
    },
    code_block: (tokens, idx, _options, env) => {
      const code = tokens[idx].content.replace(/\n$/, "")
      return renderCodeBlock(code, "text", tokens, idx, env)
    },
  }

  Object.assign(md.renderer.rules, rules)

  // Wrap renderAsync to handle post-processing and reflow automatically
  const origRenderAsync = md.renderAsync.bind(md)
  md.renderAsync = async (rawSrc: string, env?: TerminalEnv) => {
    const src = rawSrc.replace(CONTROL_RE, "")
    const renderEnv = { ...env, _mathSource: src }
    let output = await origRenderAsync(src, renderEnv)
    output = postProcessLinks(output)
    output = postProcessHeadings(output)
    output = postProcessTables(output)
    output = postProcessParagraphs(output)
    output = postProcessBlockquotes(output)
    output = output.trimEnd().replaceAll("\u00a0", " ")
    return restoreMath(output, renderEnv)
  }
}
