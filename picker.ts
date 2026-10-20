import process from "node:process"
import stringWidth from "string-width"
import {
  createPrompt,
  ExitPromptError,
  isDownKey,
  isEnterKey,
  isUpKey,
  makeTheme,
  useKeypress,
  usePagination,
  usePrefix,
  useState,
} from "@inquirer/core"
import { checkbox, confirm, select } from "@inquirer/prompts"

const COLUMN_GAP = 3
const SELECT_PREFIX_WIDTH = 2
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export interface PickerRow {
  summary: string
  model: string
  meta: string
}

function terminalColumns(): number {
  // Undefined when stdout isn't a TTY. The selector reports that error itself.
  return process.stdout.columns ?? 120
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

/** Pad each column to its widest cell so rows line up. The last column isn't padded. */
export function alignColumns(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, i) => maxWidth(rows.map((row) => row[i]))) ?? []
  return rows.map((row) =>
    row.map((cell, i) => i < row.length - 1 ? padEnd(cell, widths[i]) : cell)
      .join(" ".repeat(COLUMN_GAP))
  )
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

type Picked = { index: number; action: PickerAction | "quit" }

/** Select where Enter resumes and letter keys submit the highlighted row with an action. */
const actionSelect = createPrompt<
  Picked,
  {
    message: string
    options: string[]
    initialIndex?: number
    hint: string
    pageSize: number
  }
>((config, done) => {
  const theme = makeTheme()
  const [active, setActive] = useState(config.initialIndex ?? 0)
  const [picked, setPicked] = useState<Picked | undefined>(undefined)
  const status = picked ? "done" : "idle"
  const prefix = usePrefix({ status, theme })
  const last = config.options.length - 1

  useKeypress((key) => {
    const action = isEnterKey(key) ? "resume" : keyAction(key)
    if (action) {
      const result = { index: active, action }
      setPicked(result)
      done(result)
    } else if (isUpKey(key, ["vim"])) setActive(Math.max(0, active - 1))
    else if (isDownKey(key, ["vim"])) setActive(Math.min(last, active + 1))
    else if (key.name === "pageup") setActive(Math.max(0, active - config.pageSize))
    else if (key.name === "pagedown") setActive(Math.min(last, active + config.pageSize))
  })

  const page = usePagination({
    items: config.options,
    active,
    pageSize: config.pageSize,
    loop: false,
    renderItem: ({ item, isActive }) =>
      isActive ? theme.style.highlight(`❯ ${item}`) : `  ${item}`,
  })
  const message = theme.style.message(config.message, status)

  if (picked) {
    // Quitting and deleting leave no trace of the prompt
    if (picked.action === "quit" || picked.action === "delete") return ""
    return `${prefix} ${message} ${theme.style.answer(config.options[picked.index])}`
  }
  return [`${prefix} ${message}\n${page}`, theme.style.help(config.hint)]
})

function terminalRows(): number {
  return process.stdout.rows ?? 24
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
  try {
    const { index, action } = await actionSelect({
      ...opts,
      hint: "enter resume · s show last · S show all · f fork · d delete · q quit",
      // leave room for the message and hint lines
      pageSize: Math.max(3, terminalRows() - 3),
    })
    return action === "quit" ? undefined : { index, action }
  } catch (e) {
    // Ctrl+C
    if (e instanceof ExitPromptError) return undefined
    throw e
  }
}

/** Ctrl+C exits with 130, as dax's prompts did, instead of throwing. */
async function exitOnCancel<T>(prompt: Promise<T>): Promise<T> {
  try {
    return await prompt
  } catch (e) {
    if (e instanceof ExitPromptError) process.exit(130)
    throw e
  }
}

const indexChoices = (options: string[]) => options.map((name, value) => ({ name, value }))

/** Pick one of `options` and return its index. */
export function selectIndex(opts: {
  message: string
  options: string[]
  initialIndex?: number
}): Promise<number> {
  return exitOnCancel(select({
    message: opts.message,
    choices: indexChoices(opts.options),
    default: opts.initialIndex,
    pageSize: Math.max(3, terminalRows() - 2),
  }))
}

/** Pick any number of `options` and return their indexes. */
export function selectIndexes(
  opts: { message: string; options: string[] },
): Promise<number[]> {
  return exitOnCancel(checkbox({
    message: opts.message,
    choices: indexChoices(opts.options),
    pageSize: Math.max(3, terminalRows() - 3),
  }))
}

/** A yes/no question that defaults to no. Ctrl+C also counts as no. */
export async function confirmed(message: string, opts: { clear?: boolean } = {}) {
  try {
    return await confirm({ message, default: false }, { clearPromptOnDone: opts.clear })
  } catch (e) {
    if (e instanceof ExitPromptError) return false
    throw e
  }
}
