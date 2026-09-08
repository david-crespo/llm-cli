import type { MarkdownExit, RenderRule } from "markdown-exit"
import { encodeBase64 } from "@std/encoding/base64"
import type { MathImage } from "./math-image.ts"

export function supportsKittyGraphics(
  isTerminal = Deno.stdout.isTerminal(),
  env: (key: string) => string | undefined = (key) => Deno.env.get(key),
): boolean {
  if (!isTerminal || env("TMUX") || env("STY") || env("TERM") === "dumb") return false
  return env("TERM_PROGRAM") === "ghostty" ||
    ["xterm-ghostty", "xterm-kitty"].includes(env("TERM") ?? "")
}

// Same currency heuristics as llm-web/src/lib/math.ts.
function dollarMath(content: string, after: string): boolean {
  if (!/[\\^_{}=/,+\-()]/.test(content) && !/^[a-zA-Z]+$/.test(content)) return false
  if (content.includes("**")) return false
  if (/^\d/.test(content) && /\s/.test(content) && !/[\\^_{}]/.test(content)) return false
  return !(/^\d[\d,.]*(?:[kKmMbB])?[-+]\s*$/.test(content) && /^\d/.test(after))
}

export type MathEnv = {
  math?: boolean
  mathColor?: string
  _mathSlots?: Map<string, string>
  _mathSource?: string
  _mathNextCodepoint?: number
}

/** PNG transmission uses only direct data, so it also works over SSH. */
export function kittyImage(image: MathImage, id: number): string[] {
  const payload = encodeBase64(image.png)
  let transmit = ""
  for (let offset = 0; offset < payload.length; offset += 4096) {
    const more = offset + 4096 < payload.length ? 1 : 0
    const params = offset === 0 ? `a=t,f=100,t=d,i=${id},q=2,` : "q=2,"
    transmit += `\x1b_G${params}m=${more};${payload.slice(offset, offset + 4096)}\x1b\\`
  }
  // Place one slice per text row. This keeps tall equations intact when output
  // starts near the bottom of the screen and scrolls during printing.
  return Array.from({ length: image.rows }, (_, row) =>
    (row === 0 ? transmit : "") +
    `\x1b_Ga=p,i=${id},q=2,C=1,y=${
      row * image.rowPixels
    },h=${image.rowPixels},c=${image.columns},r=1\x1b\\` +
    " ".repeat(image.columns))
}

export function restoreMath(output: string, env: MathEnv): string {
  for (const [slot, rendered] of env._mathSlots ?? []) {
    output = output.replaceAll(slot, rendered)
  }
  return output
}

export default function mathPlugin(md: MarkdownExit): void {
  // Running inside the Markdown parser automatically excludes code spans, fenced
  // and indented code blocks, link destinations, and escaped dollar signs.
  md.inline.ruler.before("escape", "math", (state, silent) => {
    const src = state.src.slice(state.pos)
    const match = src.match(/^\$\$([\s\S]+?)\$\$|^\\\[([\s\S]+?)\\\]|^\\\(([^\n]+?)\\\)/) ??
      src.match(/^\$(?![ $])((?:\\\$|[^$\n])+?)(?<![ \\])\$/)
    if (!match) return false
    const raw = match[0]
    const content = match[1] ?? match[2] ?? match[3]
    if (
      raw.startsWith("$") && !raw.startsWith("$$") &&
      !dollarMath(content, src.slice(raw.length))
    ) return false
    if (!silent) {
      const token = state.push("math_inline", "", 0)
      token.content = content.trim()
      token.markup = raw
    }
    state.pos += raw.length
    return true
  })

  md.block.ruler.before("fence", "math", (state, start, end, silent) => {
    if (state.sCount[start] - state.blkIndent >= 4) return false
    const first = state.src.slice(
      state.bMarks[start] + state.tShift[start],
      state.eMarks[start],
    )
    const open = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\[" : ""
    if (!open) return false
    const close = open === "$$" ? "$$" : "\\]"
    const lines = [first.slice(2)]
    let last = start
    while (!lines.at(-1)!.includes(close) && last + 1 < end) {
      last++
      if (
        state.sCount[last] < state.blkIndent &&
        state.src.slice(state.bMarks[last], state.eMarks[last]).trim()
      ) return false
      lines.push(
        state.src.slice(state.bMarks[last] + state.tShift[last], state.eMarks[last]),
      )
    }
    const content = lines.join("\n")
    const index = content.indexOf(close)
    if (index < 0 || content.slice(index + 2).trim()) return false
    if (silent) return true
    const token = state.push("math_block", "", 0)
    token.block = true
    token.content = content.slice(0, index).trim()
    token.markup = open + content
    token.map = [start, last + 1]
    state.line = last + 1
    return true
  }, { alt: ["paragraph", "reference", "blockquote", "list"] })

  const render: RenderRule = async (tokens, idx, _options, environment) => {
    const env = environment as MathEnv
    const token = tokens[idx]
    const block = token.type === "math_block"
    const suffix = block ? "\n\n" : ""
    if (!env.math) return token.markup + suffix
    try {
      const { renderMathImage } = await import("./math-image.ts")
      const width = Deno.stdout.isTerminal()
        ? Math.min(Deno.consoleSize().columns, 100)
        : 80
      const image = await renderMathImage(
        token.content,
        block,
        Math.max(2, width - 8),
        env.mathColor ?? "#c8c8c8",
      )
      const id = crypto.getRandomValues(new Uint32Array(1))[0] || 1
      const rows = kittyImage(image, id)
      env._mathSlots ??= new Map()
      const placeholders = rows.map((row) => {
        let codepoint = env._mathNextCodepoint ?? 0xe000
        while (env._mathSource?.includes(String.fromCharCode(codepoint))) codepoint++
        if (codepoint > 0xf8ff) throw new Error("Too many math expressions")
        env._mathNextCodepoint = codepoint + 1
        const placeholder = String.fromCharCode(codepoint).repeat(image.columns)
        env._mathSlots!.set(placeholder, row)
        return placeholder
      })
      return placeholders.join("\n") + suffix
    } catch {
      return token.markup + suffix
    }
  }
  md.renderer.rules.math_inline = render
  md.renderer.rules.math_block = render
}
