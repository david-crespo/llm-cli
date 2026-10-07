import stringWidth from "string-width"
import { Select } from "@cliffy/prompt/select"

const COLUMN_GAP = 3
const SELECT_PREFIX_WIDTH = 2
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export interface PickerRow {
  summary: string
  model: string
  meta: string
}

function terminalColumns(): number {
  try {
    return Deno.consoleSize().columns
  } catch {
    // The selector will report the non-TTY error; this only keeps formatting
    // from replacing it with a console-size error first.
    return 120
  }
}

export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function truncateWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth <= 0) return ""
  if (maxWidth === 1) return "…"

  let result = ""
  let width = 0
  for (const { segment } of graphemes.segment(text)) {
    const segmentWidth = stringWidth(segment)
    if (width + segmentWidth >= maxWidth) break
    result += segment
    width += segmentWidth
  }
  return result.trimEnd() + "…"
}

function maxWidth(values: string[]): number {
  return Math.max(0, ...values.map((value) => stringWidth(value)))
}

function padEnd(text: string, width: number): string {
  return text + " ".repeat(width - stringWidth(text))
}

/** Format one single-line selector option per row, fitting the summary to the terminal. */
export function formatPickerOptions(
  rows: PickerRow[],
  columns = terminalColumns(),
): string[] {
  const normalized = rows.map((row) => ({
    ...row,
    summary: singleLine(row.summary),
  }))
  const modelWidth = maxWidth(normalized.map((row) => row.model))
  const metaWidth = maxWidth(normalized.map((row) => row.meta))
  const summaryBudget = Math.max(
    1,
    columns - SELECT_PREFIX_WIDTH - COLUMN_GAP * 2 - modelWidth - metaWidth,
  )
  const summaryWidth = Math.min(
    summaryBudget,
    maxWidth(normalized.map((row) => row.summary)),
  )

  return normalized.map((row) => {
    const summary = truncateWidth(row.summary, summaryWidth)
    return [
      padEnd(summary, summaryWidth),
      padEnd(row.model, modelWidth),
      row.meta,
    ].join(" ".repeat(COLUMN_GAP))
  })
}

type PickerAction = "resume" | "show" | "showAll" | "fork" | "delete"

const ACTION_KEYS: Record<string, PickerAction> = {
  r: "resume",
  s: "show",
  S: "showAll",
  f: "fork",
  d: "delete",
}

type KeyEvent = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }

/** Map a key to a picker action, "quit", or undefined to let the select handle it. */
export function keyAction(event: KeyEvent): PickerAction | "quit" | undefined {
  if (event.ctrl || event.meta || !event.name) return undefined
  if (event.name === "q" || event.name === "escape") return "quit"
  const key = event.shift ? event.name.toUpperCase() : event.name
  return ACTION_KEYS[key]
}

/** Cliffy select where letter keys submit the highlighted row with an action. */
class ActionSelect extends Select<string> {
  action: PickerAction | "quit" | undefined

  protected override async handleEvent(event: KeyEvent): Promise<void> {
    const action = keyAction(event)
    if (action) {
      this.action = action
      await this.submit()
      return
    }
    // deno-lint-ignore no-explicit-any
    await super.handleEvent(event as any)
  }

  // We only use `default` to place the cursor, so don't echo it after the message
  protected override defaults(): string {
    return ""
  }

  protected override success(value: string): string | undefined {
    // Quitting and deleting leave no trace of the prompt
    if (this.action === "quit" || this.action === "delete") return undefined
    return super.success(value)
  }
}

function terminalRows(): number {
  try {
    return Deno.consoleSize().rows
  } catch {
    return 24
  }
}

/**
 * Pick a row and an action for it. Enter resumes, letter keys do the others.
 * Returns undefined if the user quits.
 */
export async function pickWithAction(opts: {
  message: string
  options: string[]
  initialIndex?: number
}): Promise<{ index: number; action: PickerAction } | undefined> {
  const hint = "enter resume · s show last · S show all · f fork · d delete · q quit"
  const select = new ActionSelect({
    message: opts.message,
    options: opts.options.map((name, i) => ({ name, value: String(i) })),
    default: opts.initialIndex === undefined ? undefined : String(opts.initialIndex),
    hint,
    // leave room for the message and hint lines
    maxRows: Math.max(3, terminalRows() - 3),
    // The default keymap puts several letters on navigation (d, n, u, p, h, l)
    keys: {
      next: ["down", "j"],
      previous: ["up", "k"],
      nextPage: ["pagedown"],
      previousPage: ["pageup"],
      open: [],
      back: [],
    },
  })
  const value = await select.prompt()
  if (select.action === "quit") return undefined
  return { index: Number(value), action: select.action ?? "resume" }
}
