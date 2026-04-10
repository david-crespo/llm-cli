// deno-lint-ignore-file no-control-regex
import { assert, assertEquals } from "@std/assert"

import { renderMarkdown } from "./md-render.ts"

const ANSI_RE = new RegExp("\\x1b\\[[0-9;]*m|\\x1b\\]8;;[^\\x07]*\\x07", "g")
const stripAnsi = (s: string) => s.replace(ANSI_RE, "")

Deno.test("renderMarkdown reflows long blockquote text", async () => {
  const long = "word ".repeat(30).trim() // 149 chars, well over 77-char blockquote width
  const output = stripAnsi(await renderMarkdown(`> ${long}`))
  const lines = output.split("\n")
  assert(lines.length > 1, "long blockquote should wrap to multiple lines")
  assert(lines.every((l) => l.startsWith(" │ ")), "every line should have blockquote prefix")
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
