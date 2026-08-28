import stringWidth from "string-width"

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

function singleLine(text: string): string {
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
