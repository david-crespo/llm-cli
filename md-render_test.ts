// deno-lint-ignore-file no-control-regex
import { assert, assertEquals } from "@std/assert"

import { renderMarkdown } from "./md-render.ts"

const ANSI_RE = new RegExp("\\x1b\\[[0-9;]*m|\\x1b\\]8;;[^\\x07]*\\x07", "g")
// Codespans use NBSP for padding/internal spaces so wrap-ansi treats them as
// unbreakable; normalize to regular spaces for visual-equality assertions.
const stripAnsi = (s: string) => s.replace(ANSI_RE, "").replaceAll(" ", " ")

Deno.test("renderMarkdown reflows long blockquote text", async () => {
  const long = "word ".repeat(30).trim() // 149 chars, well over 77-char blockquote width
  const output = stripAnsi(await renderMarkdown(`> ${long}`))
  const lines = output.split("\n")
  assert(lines.length > 1, "long blockquote should wrap to multiple lines")
  assert(
    lines.every((l) => l.startsWith(" │ ")),
    "every line should have blockquote prefix",
  )
})

Deno.test("renderMarkdown handles nested blockquotes", async () => {
  const output = await renderMarkdown("> outer\n> > inner\n> back")
  assert(!output.includes("\x00"))
  assertEquals(stripAnsi(output), " │ outer\n │\n │  │ inner\n │  │ back")
})

Deno.test("renderMarkdown preserves list item paragraph breaks", async () => {
  const output = await renderMarkdown("- first paragraph\n\n  second paragraph")
  assertEquals(stripAnsi(output), "* first paragraph\n  second paragraph")
})

Deno.test("renderMarkdown sizes tables from visible link text", async () => {
  const output = stripAnsi(
    await renderMarkdown("| h |\n| - |\n| [x](https://example.com) |"),
  )
  const lines = output.split("\n")
  const paddedWidth = lines[1].slice(2, -2).length
  const headerWidth = lines[1].slice(2, -2).trimEnd().length
  const bodyWidth = lines[3].slice(2, -2).trimEnd().length

  assertEquals(paddedWidth, Math.max(3, headerWidth, bodyWidth))
})

Deno.test("renderMarkdown sizes emoji grapheme clusters as width 2 in tables", async () => {
  const output = stripAnsi(
    await renderMarkdown("| x |\n| - |\n| 👨‍👩‍👧‍👦 |\n| 🇯🇵 |\n| 🏴‍☠️ |"),
  )

  assertEquals(
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

Deno.test("renderMarkdown keeps mixed-width emoji columns aligned", async () => {
  const output = stripAnsi(
    await renderMarkdown(
      "| kind | value |\n| --- | --- |\n| family | 👨‍👩‍👧‍👦 |\n| flag | 🇯🇵 |\n| pirate | 🏴‍☠️ |",
    ),
  )

  assertEquals(
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

Deno.test("renderMarkdown handles common inline markdown", async () => {
  const output = stripAnsi(
    await renderMarkdown(
      "# Title\n\nParagraph with **bold**, *italic*, ~~strike~~, `code`, and [link](https://example.com).",
    ),
  )

  assertEquals(
    output,
    "# Title\n\nParagraph with bold, italic, strike,  code , and link (https://example.com).",
  )
})

Deno.test("renderMarkdown handles basic lists", async () => {
  const output = stripAnsi(
    await renderMarkdown("- first\n- second\n  - nested\n\n1. one\n2. two"),
  )

  assertEquals(output, "* first\n* second\n  * nested\n\n1. one\n2. two")
})

Deno.test("renderMarkdown handles basic fenced code blocks", async () => {
  const output = stripAnsi(
    await renderMarkdown("```ts\nconst x = 1\nconsole.log(x)\n```"),
  )

  assertEquals(output, "  const x = 1\n  console.log(x)")
})

Deno.test("renderMarkdown keeps codespans on a single line when wrapped", async () => {
  // wrap-ansi will split a styled codespan if it contains breakable spaces,
  // which either leaks bg color to end-of-line (BCE) or strands a lone styled
  // space at the line edge. Codespans pad with NBSP and replace internal
  // spaces with NBSP so wrap-ansi treats them as a single unbreakable word.
  const text =
    "The function takes any iterable of `T` (arrays, sets, generators, etc.) and a `keyFn` that derives a grouping key from each item.\n\n" +
    "The type parameter `K extends PropertyKey` constrains keys to `string | number | symbol` — the only types JavaScript allows as object keys. This lets the return type be a precise `Record<K, T[]>` rather than a loose `Record<string, T[]>`.\n\n" +
    "Inside the loop, `result[key] ??= []` uses the operator: if `result[key]` is `undefined`, more text. The classic `if (!result[key]) result[key] = []; result[key].push(item);` form."

  const origIsTerminal = Deno.stdout.isTerminal.bind(Deno.stdout)
  const origConsoleSize = Deno.consoleSize
  Deno.stdout.isTerminal = () => true
  try {
    for (const columns of [50, 62, 70, 80, 85, 88, 90, 92, 95, 100, 120]) {
      Deno.consoleSize = () => ({ columns, rows: 40 })
      const out = await renderMarkdown(text)
      for (const [i, line] of out.split("\n").entries()) {
        const opens = (line.match(/\x1b\[38;5;203m\x1b\[48;5;236m/g) ?? []).length
        const closes = (line.match(/\x1b\[49m\x1b\[39m/g) ?? []).length
        assertEquals(
          opens,
          closes,
          `columns=${columns} line ${i} has unbalanced codespan SGR: ${
            JSON.stringify(line)
          }`,
        )
        // Catch the lone-styled-space artifact: a codespan whose visible
        // content is only whitespace means wrap-ansi sliced one out.
        const lone = new RegExp(
          "\\x1b\\[38;5;203m\\x1b\\[48;5;236m\\s*\\x1b\\[49m\\x1b\\[39m",
        )
        assertEquals(
          lone.test(line),
          false,
          `columns=${columns} line ${i} contains a whitespace-only codespan: ${
            JSON.stringify(line)
          }`,
        )
      }
    }
  } finally {
    Deno.stdout.isTerminal = origIsTerminal
    Deno.consoleSize = origConsoleSize
  }
})

Deno.test("renderMarkdown handles simple tables", async () => {
  const output = stripAnsi(await renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |"))

  assertEquals(
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
