// deno-lint-ignore-file no-control-regex
//
// markdown-exit plugin that renders to ANSI-styled terminal output.
// Install with md.use(terminalPlugin), then call md.renderAsync(src, env).
// Post-processing (links, tables, blockquotes, reflow) is handled
// automatically by wrapping renderAsync.

import type { MarkdownExit, RenderRule } from "markdown-exit"
import ansis, { blue, bold, cyan, dim, gray, italic, strikethrough, white } from "ansis"
import stringWidth from "string-width"
import supportsHyperlinks from "supports-hyperlinks"
import wrapAnsi from "wrap-ansi"

const { fg } = ansis

// --- Styling -----------------------------------------------------------

const h1 = white.bg(63).bold
const h2 = blue.bold
const codespan = fg(203).bg(236)
const tableBorder = gray
const tableHeader = cyan.bold

function hyperlink(url: string, text: string): string {
  if (!supportsHyperlinks.stdout) return `${blue(text)} (${dim(url)})`
  return `\x1b]8;;${url}\x07${blue(text)}\x1b]8;;\x07`
}

// --- Utilities ---------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g
const stripAnsi = (s: string) => s.replace(ANSI_RE, "")

// --- Reflow ------------------------------------------------------------

const reflowText = (text: string, maxWidth: number): string =>
  maxWidth <= 0 ? text : wrapAnsi(text, maxWidth, { trim: false })

// --- Table renderer ----------------------------------------------------

function renderTable(rows: string[][], headerCount: number): string {
  if (rows.length === 0) return ""

  const cols = Math.max(...rows.map((r) => r.length))
  const widths = Array.from(
    { length: cols },
    (_, c) => Math.max(3, ...rows.map((r) => stringWidth(r[c] ?? ""))),
  )

  const pad = (s: string, w: number) => s + " ".repeat(w - stringWidth(s))
  const rule = (l: string, m: string, r: string) =>
    tableBorder(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r)
  const row = (cells: string[], isHeader: boolean) =>
    tableBorder("│ ") +
    widths
      .map((w, c) => {
        const p = pad(cells[c] ?? "", w)
        return isHeader ? tableHeader(p) : p
      })
      .join(tableBorder(" │ ")) +
    tableBorder(" │")

  return [
    rule("╭", "┬", "╮"),
    ...rows.flatMap((cells, r) => [
      row(cells, r < headerCount),
      ...(r === headerCount - 1 ? [rule("├", "┼", "┤")] : []),
    ]),
    rule("╰", "┴", "╯"),
  ].join("\n")
}

// --- State for block-level tracking ------------------------------------

type RenderState = {
  listDepth: number
  listOrdered: boolean[]
  listCounters: number[]
  listItemParagraphs: number[]
  listItemPrefixes: string[]
  blockquoteDepth: number
}

function freshState(): RenderState {
  return {
    listDepth: 0,
    listOrdered: [],
    listCounters: [],
    listItemParagraphs: [],
    listItemPrefixes: [],
    blockquoteDepth: 0,
  }
}

// deno-lint-ignore no-explicit-any
function getState(env: any): RenderState {
  if (!env._termState) env._termState = freshState()
  return env._termState
}

// --- Code highlighting -------------------------------------------------

async function highlightCode(code: string, lang: string, theme = "ayu-mirage") {
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
  return highlighted.split("\n").map((l) => "  " + l).join("\n") + "\n\n"
}

// --- Post-processing ---------------------------------------------------

function postProcessLinks(text: string): string {
  return text.replace(
    /\x00LINK:(.*?)\x00([\s\S]*?)\x00\/LINK\x00/g,
    (_, href, linkText) => hyperlink(href, linkText),
  )
}

function postProcessBlockquotes(text: string, width: number): string {
  let maxDepth = 0
  for (const [, depth] of text.matchAll(/\x00BQ_OPEN:(\d+)\x00/g)) {
    maxDepth = Math.max(maxDepth, Number(depth))
  }

  let result = text
  for (let depth = maxDepth; depth > 0; depth--) {
    result = result.replace(
      new RegExp(
        `\x00BQ_OPEN:${depth}\x00([\\s\\S]*?)\x00BQ_CLOSE:${depth}\x00`,
        "g",
      ),
      (_, content: string) => {
        const prefix = gray(" │ ")
        const blankPrefix = gray(" │")
        const maxWidth = width - 3 // account for " │ " prefix
        const paragraphs = content
          .split("\x00BQ_PARA\x00")
          .filter((p) => p.trim())
        const reflowed = paragraphs.map((p) => {
          const lines = reflowText(p.trimEnd(), maxWidth).split("\n")
          return lines.map((l: string) => prefix + italic(l)).join("\n")
        })
        return reflowed.join("\n" + blankPrefix + "\n") + "\n\n"
      },
    )
  }
  return result
}

function postProcessTables(text: string): string {
  const extractCells = (row: string) =>
    [...row.matchAll(/\x00CELL\x00([\s\S]*?)\x00\/CELL\x00/g)].map((m) => m[1].trim())

  return text.replace(
    /\x00TABLE\x00([\s\S]*?)\x00\/TABLE\x00/g,
    (_, content: string) => {
      const rows = [...content.matchAll(/\x00TR\x00([\s\S]*?)\x00\/TR\x00/g)]
        .map((m) => extractCells(m[1]))
      const thead = content.match(/\x00THEAD\x00([\s\S]*?)\x00\/THEAD\x00/)
      const headerRows = thead ? [...thead[1].matchAll(/\x00TR\x00/g)].length : 0
      return renderTable(rows, headerRows) + "\n\n"
    },
  )
}

function reflowParagraphs(text: string, columns: number, width: number): string {
  if (columns <= 80) return text
  return text.replace(/^([^\n]+)\n\n/gm, (match, para) => {
    if (/^(\s*(#|[*\-]|\d+\.)|│|╭|├|╰| {4})/.test(stripAnsi(para))) {
      return match
    }
    return reflowText(para, width) + "\n\n"
  })
}

// --- Plugin ------------------------------------------------------------

export type TerminalEnv = { codeTheme?: string }

export default function terminalPlugin(md: MarkdownExit): void {
  const columns = Deno.stdout.isTerminal() ? Deno.consoleSize().columns : 80
  const width = Math.min(columns, 100)

  const rules: Record<string, RenderRule> = {
    // Inline
    text: (tokens, idx) => tokens[idx].content,
    code_inline: (tokens, idx) => codespan(` ${tokens[idx].content} `),
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
      const alt = tokens[idx].content ||
        tokens[idx].children?.[0]?.content || "image"
      return dim(`![${alt}](${src})`)
    },

    // Block
    heading_open: (tokens, idx) => {
      const level = parseInt(tokens[idx].tag.slice(1))
      const style = level === 1 ? h1 : h2
      return style.open + "#".repeat(level) + " "
    },
    heading_close: (tokens, idx) => {
      const level = parseInt(tokens[idx].tag.slice(1))
      const style = level === 1 ? h1 : h2
      return style.close + "\n\n"
    },
    paragraph_open: (_tokens, _idx, _options, env) => {
      const s = getState(env)
      return s.listDepth > 0 && (s.listItemParagraphs.at(-1) ?? 0) > 0
        ? `\n${s.listItemPrefixes.at(-1) ?? ""}`
        : ""
    },
    paragraph_close: (_tokens, _idx, _options, env) => {
      const s = getState(env)
      if (s.listDepth > 0) {
        const i = s.listItemParagraphs.length - 1
        if (i >= 0) s.listItemParagraphs[i]++
        return ""
      }
      if (s.blockquoteDepth > 0) return "\x00BQ_PARA\x00"
      return "\n\n"
    },
    hr: () => gray("─".repeat(width)) + "\n\n",
    blockquote_open: (_tokens, _idx, _options, env) => {
      const s = getState(env)
      s.blockquoteDepth++
      return `\x00BQ_OPEN:${s.blockquoteDepth}\x00`
    },
    blockquote_close: (_tokens, _idx, _options, env) => {
      const s = getState(env)
      const marker = `\x00BQ_CLOSE:${s.blockquoteDepth}\x00`
      s.blockquoteDepth--
      return marker
    },

    // Lists
    bullet_list_open: (_tokens, _idx, _options, env) => {
      const s = getState(env)
      s.listDepth++
      s.listOrdered.push(false)
      s.listCounters.push(0)
      return s.listDepth > 1 ? "\n" : ""
    },
    bullet_list_close: (_tokens, _idx, _options, env) => {
      const s = getState(env)
      s.listDepth--
      s.listOrdered.pop()
      s.listCounters.pop()
      return s.listDepth === 0 ? "\n" : ""
    },
    ordered_list_open: (tokens, idx, _options, env) => {
      const s = getState(env)
      s.listDepth++
      s.listOrdered.push(true)
      const start = parseInt(tokens[idx].attrGet("start") ?? "1")
      s.listCounters.push(start - 1)
      return s.listDepth > 1 ? "\n" : ""
    },
    ordered_list_close: (_tokens, _idx, _options, env) => {
      const s = getState(env)
      s.listDepth--
      s.listOrdered.pop()
      s.listCounters.pop()
      return s.listDepth === 0 ? "\n" : ""
    },
    list_item_open: (_tokens, _idx, _options, env) => {
      const s = getState(env)
      const indent = "  ".repeat(s.listDepth - 1)
      const isOrdered = s.listOrdered[s.listOrdered.length - 1]
      let prefix: string
      if (isOrdered) {
        const counter = ++s.listCounters[s.listCounters.length - 1]
        prefix = `${indent}${counter}. `
      } else {
        prefix = `${indent}* `
      }
      s.listItemParagraphs.push(0)
      s.listItemPrefixes.push(" ".repeat(prefix.length))
      return prefix
    },
    list_item_close: (tokens, idx, _options, env) => {
      const s = getState(env)
      s.listItemParagraphs.pop()
      s.listItemPrefixes.pop()
      if (idx > 0) {
        const prev = tokens[idx - 1].type
        if (prev === "bullet_list_close" || prev === "ordered_list_close") {
          return ""
        }
      }
      return "\n"
    },

    // Tables — markers assembled in post-processing
    table_open: () => "\x00TABLE\x00",
    table_close: () => "\x00/TABLE\x00",
    thead_open: () => "\x00THEAD\x00",
    thead_close: () => "\x00/THEAD\x00",
    tbody_open: () => "",
    tbody_close: () => "",
    tr_open: () => "\x00TR\x00",
    tr_close: () => "\x00/TR\x00",
    th_open: () => "\x00CELL\x00",
    th_close: () => "\x00/CELL\x00",
    td_open: () => "\x00CELL\x00",
    td_close: () => "\x00/CELL\x00",

    // Code blocks — async, handled by renderAsync
    fence: (tokens, idx, _options, env) => {
      const token = tokens[idx]
      const lang = token.info.trim().split(/\s+/)[0] || "text"
      const code = token.content.replace(/\n$/, "")
      return highlightCode(code, lang, env.codeTheme)
    },
    code_block: (tokens, idx, _options, env) => {
      const code = tokens[idx].content.replace(/\n$/, "")
      return highlightCode(code, "text", env.codeTheme)
    },
  }

  Object.assign(md.renderer.rules, rules)

  // Wrap renderAsync to handle post-processing and reflow automatically
  const origRenderAsync = md.renderAsync.bind(md)
  md.renderAsync = async (src: string, env?: TerminalEnv) => {
    let output = await origRenderAsync(src, env ?? {})
    output = postProcessLinks(output)
    output = postProcessTables(output)
    output = postProcessBlockquotes(output, width)
    output = reflowParagraphs(output, columns, width)
    return output.trimEnd()
  }
}
