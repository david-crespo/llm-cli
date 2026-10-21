import assert from "node:assert/strict"
import { test } from "node:test"
import process from "node:process"

import ansis from "ansis"

import { codespan, h1, h2 } from "./markdown-exit-terminal.ts"
import { renderMarkdown } from "./md-render.ts"

const ANSI_RE = new RegExp("\\x1b\\[[0-9;]*m|\\x1b\\]8;;[^\\x07]*\\x07", "g")
const stripAnsi = (s: string) => s.replace(ANSI_RE, "")

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

async function withColumns<T>(columns: number, fn: () => Promise<T>): Promise<T> {
  const { stdout } = process
  const original = Object.getOwnPropertyDescriptor(stdout, "columns")
  stdout.columns = columns
  try {
    return await fn()
  } finally {
    if (original) Object.defineProperty(stdout, "columns", original)
    else delete (stdout as { columns?: number }).columns
  }
}

test("renderMarkdown wraps list items with a hanging indent", async () => {
  const src = [
    "- alpha beta gamma delta epsilon zeta",
    "  - eta theta iota kappa lambda mu",
    "",
    "9. one two three four five six seven",
    "10. one two three four five six seven",
  ].join("\n")
  const output = stripAnsi(await withColumns(20, () => renderMarkdown(src)))

  assert.deepEqual(
    output,
    [
      "* alpha beta gamma",
      "  delta epsilon zeta",
      "  * eta theta iota",
      "    kappa lambda mu",
      "",
      " 9. one two three",
      "    four five six",
      "    seven",
      "10. one two three",
      "    four five six",
      "    seven",
    ].join("\n"),
  )
})

test("renderMarkdown right-aligns ordered list numbers", async () => {
  const src = "9. nine is longer\n10. ten\n    - nested under ten"
  const output = stripAnsi(await withColumns(16, () => renderMarkdown(src)))

  assert.deepEqual(
    output,
    " 9. nine is\n    longer\n10. ten\n    * nested\n      under ten",
  )
})

test("renderMarkdown wraps later list item paragraphs with the same indent", async () => {
  const src = "- first paragraph here\n\n  second paragraph is longer"
  const output = stripAnsi(await withColumns(20, () => renderMarkdown(src)))

  assert.deepEqual(output, "* first paragraph\n  here\n  second paragraph\n  is longer")
})

test("renderMarkdown indents code blocks inside list items", async () => {
  const src = "- install it:\n\n  ```\n  npm install\n  ```\n\n  then run it\n- next"
  const output = stripAnsi(await renderMarkdown(src))

  assert.deepEqual(output, "* install it:\n    npm install\n  then run it\n* next")
})

test("renderMarkdown strips control characters from the source", async () => {
  const output = await renderMarkdown(
    "a\x1b[2Jb `c\x1b]0;title\x07d`\n\n```\ne\x9bf\tg\n```",
  )

  assert.deepEqual(stripAnsi(output), "a[2Jb  c]0;titled \n\n  ef\tg")
})

test("renderMarkdown leaves no NBSPs in codespans, so copied code pastes intact", async () => {
  // Wrapped so the codespan ends a line: without colors, a codespan starting a
  // line loses its leading pad to wrap-ansi's trim, which is invisible
  const output = await withColumns(20, () => renderMarkdown("Run `npm run build` first."))

  assert(!output.includes("\u00a0"), JSON.stringify(output))
  assert.deepEqual(stripAnsi(output), "Run  npm run build \nfirst.")
})

test("renderMarkdown prints autolinked URLs once without OSC 8", async () => {
  const output = stripAnsi(
    await renderMarkdown(
      "See https://example.com/x, <https://a.dev>, b@c.co, and example.com.",
    ),
  )

  assert.deepEqual(
    output,
    "See https://example.com/x, https://a.dev, b@c.co, and example.com.",
  )
})

test("renderMarkdown renders task list checkboxes in place of the bullet", async () => {
  const src =
    "- [ ] write the tests first\n- [x] fix the bug\n  - [X] nested\n- [link](u) stays"
  const output = await withColumns(20, () => renderMarkdown(src))

  assert.deepEqual(
    stripAnsi(output),
    "[ ] write the tests\n    first\n[x] fix the bug\n    [x] nested\n* link (u) stays",
  )
})

test("renderMarkdown indents blockquotes, tables and headings inside list items", async () => {
  const src = [
    "- quote:",
    "",
    "  > quoted text in an item that wraps",
    "- table:",
    "",
    "  | a | b |",
    "  | - | - |",
    "  | 1 | 2 |",
    "- ## heading",
    "- last",
  ].join("\n")
  const output = stripAnsi(await withColumns(24, () => renderMarkdown(src)))

  assert.deepEqual(
    output,
    [
      "* quote:",
      "   │ quoted text in an",
      "   │ item that wraps",
      "* table:",
      "  ╭─────┬─────╮",
      "  │ a   │ b   │",
      "  ├─────┼─────┤",
      "  │ 1   │ 2   │",
      "  ╰─────┴─────╯",
      "* ## heading",
      "* last",
    ].join("\n"),
  )
})

test("renderMarkdown indents lists inside blockquotes inside lists", async () => {
  const src = "- outer\n\n  > - inner item text\n  >\n  >   more"
  const output = stripAnsi(await withColumns(20, () => renderMarkdown(src)))

  assert.deepEqual(output, "* outer\n   │ * inner item\n   │   text\n   │   more")
})

test("renderMarkdown puts no blank line after a nested list in the same item", async () => {
  const output = stripAnsi(await renderMarkdown("- a\n  - b\n\n  para in a\n- c"))

  assert.deepEqual(output, "* a\n  * b\n  para in a\n* c")
})

test("renderMarkdown fits rules inside blockquotes and lists", async () => {
  const output = stripAnsi(
    await withColumns(20, () => renderMarkdown("> a\n>\n> ---\n\n- b\n\n  ***\n- c")),
  )

  assert.deepEqual(
    output,
    [" │ a", " │", " │ " + "─".repeat(17), "", "* b", "  " + "─".repeat(18), "* c"].join(
      "\n",
    ),
  )
})

test("renderMarkdown trims whitespace at paragraph wrap points", async () => {
  // A word longer than the width overflows, and the following space must not
  // start the next line
  const src = "see a-very-long-identifier-name for more"
  const output = stripAnsi(await withColumns(20, () => renderMarkdown(src)))

  assert.deepEqual(output, "see\na-very-long-identifier-name\nfor more")
})

test("renderMarkdown wraps paragraphs that start like list markers", async () => {
  const src = "--force skips the check and you should not pass it"
  const output = stripAnsi(await withColumns(20, () => renderMarkdown(src)))

  assert.deepEqual(output, "--force skips the\ncheck and you should\nnot pass it")
})

test("renderMarkdown wraps nested blockquotes once", async () => {
  const src = "> > " + "word ".repeat(8).trim()
  const output = stripAnsi(await withColumns(20, () => renderMarkdown(src)))

  assert.deepEqual(output, " │  │ word word word\n │  │ word word word\n │  │ word word")
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
  const output = stripAnsi(await renderMarkdown("| x |\n| - |\n| 👨‍👩‍👧‍👦 |\n| 🇯🇵 |\n| 🏴‍☠️ |"))

  assert.deepEqual(
    output,
    ["╭─────╮", "│ x   │", "├─────┤", "│ 👨‍👩‍👧‍👦  │", "│ 🇯🇵  │", "│ 🏴‍☠️  │", "╰─────╯"].join(
      "\n",
    ),
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
  const output = stripAnsi(await renderMarkdown("```ts\nconst x = 1\nconsole.log(x)\n```"))

  assert.deepEqual(output, "  const x = 1\n  console.log(x)")
})

test(
  "renderMarkdown keeps codespans on a single line when wrapped",
  {
    // Without colors there is no styled span to split
    skip: !codespan.open && "colors are disabled",
  },
  async () => {
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
          const shown = JSON.stringify(line)
          const opens = line.split(open).length - 1
          const closes = line.split(close).length - 1
          assert.deepEqual(
            opens,
            closes,
            `columns=${columns} line ${i} has unbalanced codespan SGR: ${shown}`,
          )
          assert.deepEqual(
            lone.test(line),
            false,
            `columns=${columns} line ${i} contains a whitespace-only codespan: ${shown}`,
          )
        }
      }
    } finally {
      for (const key of ["isTTY", "columns"] as const) {
        if (original[key]) Object.defineProperty(stdout, key, original[key])
        else delete stdout[key]
      }
    }
  },
)

test("renderMarkdown respects table column alignment", async () => {
  const output = stripAnsi(
    await renderMarkdown(
      "| left | right | mid |\n| :- | -: | :-: |\n| a | 1 | x |\n| bb | 22 | yyy |",
    ),
  )

  assert.deepEqual(
    output,
    [
      "╭──────┬───────┬─────╮",
      "│ left │ right │ mid │",
      "├──────┼───────┼─────┤",
      "│ a    │     1 │  x  │",
      "│ bb   │    22 │ yyy │",
      "╰──────┴───────┴─────╯",
    ].join("\n"),
  )
})

test("renderMarkdown wraps table cells to fit the terminal", async () => {
  const src = "| a | b |\n| - | - |\n| short | one two three four five six |"
  const output = stripAnsi(await withColumns(24, () => renderMarkdown(src)))

  assert.deepEqual(
    output,
    [
      "╭───────┬──────────────╮",
      "│ a     │ b            │",
      "├───────┼──────────────┤",
      "│ short │ one two      │",
      "│       │ three four   │",
      "│       │ five six     │",
      "╰───────┴──────────────╯",
    ].join("\n"),
  )
})

test("renderMarkdown keeps wide tables within the width, in blockquotes too", async () => {
  const cell = "word ".repeat(20).trim()
  const table = `| x | y | z |\n| - | - | - |\n| ${cell} | ${cell} | \`a-long-unbreakable-identifier\` |`
  for (const src of [table, table.replace(/^/gm, "> ")]) {
    const lines = stripAnsi(await withColumns(40, () => renderMarkdown(src))).split("\n")
    for (const line of lines) assert(line.length <= 40, `too wide: ${JSON.stringify(line)}`)
  }
})

// Without colors there are no styles to cut short
const skipNoColor = { skip: !codespan.open && "colors are disabled" }

test(
  "renderMarkdown keeps the heading style after inline styles",
  skipNoColor,
  async () => {
    // ansis reopens the outer style after each nested close
    assert.deepEqual(
      await renderMarkdown("## The `parse` function"),
      h2(`## The ${codespan(" parse ")} function`),
    )
    assert.deepEqual(
      await renderMarkdown("# Use `foo` here"),
      h1(`# Use ${codespan(" foo ")} here`),
    )
  },
)

test("renderMarkdown keeps a done task dimmed after bold", skipNoColor, async () => {
  const { dim, bold, green } = ansis
  assert.deepEqual(
    await renderMarkdown("- [x] fixed **the** bug"),
    `${green("[x]")} ${dim(`fixed ${bold("the")} bug`)}`,
  )
})

test(
  "renderMarkdown italicizes blockquote paragraphs but not code",
  skipNoColor,
  async () => {
    const lines = (await renderMarkdown("> quote text\n>\n> ```\n> code\n> ```")).split(
      "\n",
    )
    const italic = ansis.italic.open

    assert(
      lines.find((l) => l.includes("quote text"))?.includes(italic),
      "quote text is italic",
    )
    assert(!lines.find((l) => l.includes("code"))?.includes(italic), "code is not italic")
  },
)

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
