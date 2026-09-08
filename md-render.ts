import { MarkdownExit } from "markdown-exit"
import terminalPlugin from "./markdown-exit-terminal.ts"
import { supportsKittyGraphics } from "./terminal-math.ts"

export type RenderOptions = {
  /** Shiki theme for fenced code blocks. Defaults to "ayu-mirage". */
  codeTheme?: string
  /** Render equations using Kitty graphics. Defaults to Ghostty/Kitty detection. */
  math?: boolean
  /** Equation foreground; defaults to light gray for the terminal's dark theme. */
  mathColor?: string
}

const md = new MarkdownExit({ html: true, linkify: true })
md.use(terminalPlugin)

/** Render markdown to ANSI-styled terminal output. */
export function renderMarkdown(md_text: string, opts: RenderOptions = {}): Promise<string> {
  return md.renderAsync(md_text, {
    codeTheme: opts.codeTheme ?? "ayu-mirage",
    math: opts.math ?? supportsKittyGraphics(),
    mathColor: opts.mathColor,
  })
}
