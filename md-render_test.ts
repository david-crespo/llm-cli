import assert from "node:assert/strict"
import { test } from "node:test"
import process from "node:process"

import { codespan } from "./markdown-exit-terminal.ts"
import { renderMarkdown } from "./md-render.ts"

const ANSI_RE = new RegExp("\\x1b\\[[0-9;]*m|\\x1b\\]8;;[^\\x07]*\\x07", "g")
// Codespans use NBSP for padding/internal spaces so wrap-ansi treats them as
// unbreakable; normalize to regular spaces for visual-equality assertions.
const stripAnsi = (s: string) => s.replace(ANSI_RE, "").replaceAll(" ", " ")

test("renderMarkdown reflows long blockquote text", async () => {
  const long = "word ".repeat(30).trim() // 149 chars, well over 77-char blockquote width
  const output = stripAnsi(await renderMarkdown(`> ${long}`))
  const lines = output.split("\n")
  assert(lines.length > 1, "long blockquote should wrap to multiple lines")
  assert(
    lines.every((l) => l.startsWith(" │ ")),
    "every line should have blockquote prefix",
  )
})

test("renderMarkdown handles nested blockquotes", async () => {
  const output = await renderMarkdown("> outer\n> > inner\n> back")
  assert(!output.includes("\x00"))
  assert.deepEqual(stripAnsi(output), " │ outer\n │\n │  │ inner\n │  │ back")
})

test("renderMarkdown preserves list item paragraph breaks", async () => {
  const output = await renderMarkdown("- first paragraph\n\n  second paragraph")
  assert.deepEqual(stripAnsi(output), "* first paragraph\n  second paragraph")
})

test("renderMarkdown sizes tables from visible link text", async () => {
  const output = stripAnsi(
    await renderMarkdown("| h |\n| - |\n| [x](https://example.com) |"),
  )
  const lines = output.split("\n")
  const paddedWidth = lines[1].slice(2, -2).length
  const headerWidth = lines[1].slice(2, -2).trimEnd().length
  const bodyWidth = lines[3].slice(2, -2).trimEnd().length

  assert.deepEqual(paddedWidth, Math.max(3, headerWidth, bodyWidth))
})

test("renderMarkdown sizes emoji grapheme clusters as width 2 in tables", async () => {
  const output = stripAnsi(
    await renderMarkdown("| x |\n| - |\n| 👨‍👩‍👧‍👦 |\n| 🇯🇵 |\n| 🏴‍☠️ |"),
  )

  assert.deepEqual(
    output,
    [
      "╭─────╮",
      "│ x   │",
      "├─────┤",
      "│ 👨‍👩‍👧‍👦  │",
      "│ 🇯🇵  │",
      "│ 🏴‍☠️  │",
      "╰─────╯",
    ].join("\n"),
  )
})

test("renderMarkdown keeps mixed-width emoji columns aligned", async () => {
  const output = stripAnsi(
    await renderMarkdown(
      "| kind | value |\n| --- | --- |\n| family | 👨‍👩‍👧‍👦 |\n| flag | 🇯🇵 |\n| pirate | 🏴‍☠️ |",
    ),
  )

  assert.deepEqual(
    output,
    [
      "╭────────┬───────╮",
      "│ kind   │ value │",
      "├────────┼───────┤",
      "│ family │ 👨‍👩‍👧‍👦    │",
      "│ flag   │ 🇯🇵    │",
      "│ pirate │ 🏴‍☠️    │",
      "╰────────┴───────╯",
    ].join("\n"),
  )
})

test("renderMarkdown handles common inline markdown", async () => {
  const output = stripAnsi(
    await renderMarkdown(
      "# Title\n\nParagraph with **bold**, *italic*, ~~strike~~, `code`, and [link](https://example.com).",
    ),
  )

  assert.deepEqual(
    output,
    "# Title\n\nParagraph with bold, italic, strike,  code , and link (https://example.com).",
  )
})

test("renderMarkdown handles basic lists", async () => {
  const output = stripAnsi(
    await renderMarkdown("- first\n- second\n  - nested\n\n1. one\n2. two"),
  )

  assert.deepEqual(output, "* first\n* second\n  * nested\n\n1. one\n2. two")
})

test("renderMarkdown handles basic fenced code blocks", async () => {
  const output = stripAnsi(
    await renderMarkdown("```ts\nconst x = 1\nconsole.log(x)\n```"),
  )

  assert.deepEqual(output, "  const x = 1\n  console.log(x)")
})

test("renderMarkdown keeps codespans on a single line when wrapped", {
  // Without colors there is no styled span to split
  skip: !codespan.open && "colors are disabled",
}, async () => {
  // wrap-ansi will split a styled codespan if it contains breakable spaces,
  // which either leaks bg color to end-of-line (BCE) or strands a lone styled
  // space at the line edge. Codespans pad with NBSP and replace internal
  // spaces with NBSP so wrap-ansi treats them as a single unbreakable word.
  const text =
    "The function takes any iterable of `T` (arrays, sets, generators, etc.) and a `keyFn` that derives a grouping key from each item.\n\n" +
    "The type parameter `K extends PropertyKey` constrains keys to `string | number | symbol` — the only types JavaScript allows as object keys. This lets the return type be a precise `Record<K, T[]>` rather than a loose `Record<string, T[]>`.\n\n" +
    "Inside the loop, `result[key] ??= []` uses the operator: if `result[key]` is `undefined`, more text. The classic `if (!result[key]) result[key] = []; result[key].push(item);` form."

  // The escape codes depend on the color level: `node --test` sets
  // FORCE_COLOR=1 for test files when its own output is a terminal.
  const { open, close } = codespan
  // A codespan whose visible content is only whitespace means wrap-ansi sliced one out
  const lone = new RegExp(`${RegExp.escape(open)}\\s*${RegExp.escape(close)}`)

  const { stdout } = process
  const original = Object.getOwnPropertyDescriptors(stdout)
  stdout.isTTY = true
  try {
    for (const columns of [50, 62, 70, 80, 85, 88, 90, 92, 95, 100, 120]) {
      stdout.columns = columns
      const out = await renderMarkdown(text)
      for (const [i, line] of out.split("\n").entries()) {
        const opens = line.split(open).length - 1
        const closes = line.split(close).length - 1
        assert.deepEqual(
          opens,
          closes,
          `columns=${columns} line ${i} has unbalanced codespan SGR: ${
            JSON.stringify(line)
          }`,
        )
        assert.deepEqual(
          lone.test(line),
          false,
          `columns=${columns} line ${i} contains a whitespace-only codespan: ${
            JSON.stringify(line)
          }`,
        )
      }
    }
  } finally {
    for (const key of ["isTTY", "columns"] as const) {
      if (original[key]) Object.defineProperty(stdout, key, original[key])
      else delete stdout[key]
    }
  }
})

test("renderMarkdown handles simple tables", async () => {
  const output = stripAnsi(await renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |"))

  assert.deepEqual(
    output,
    [
      "╭─────┬─────╮",
      "│ a   │ b   │",
      "├─────┼─────┤",
      "│ 1   │ 2   │",
      "╰─────┴─────╯",
    ].join("\n"),
  )
})
