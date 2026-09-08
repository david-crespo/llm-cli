// deno-lint-ignore-file no-control-regex
import { assert, assertEquals, assertRejects } from "@std/assert"
import { decodeBase64 } from "@std/encoding/base64"
import { renderMarkdown } from "./md-render.ts"
import { kittyImage, supportsKittyGraphics } from "./terminal-math.ts"
import { renderMathImage } from "./math-image.ts"

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replaceAll(" ", " ")
const imageCount = (s: string) => [...s.matchAll(/\x1b_Ga=t,/g)].length

Deno.test("Kitty detection requires a supported terminal outside multiplexers", () => {
  for (
    const env of [{ TERM_PROGRAM: "ghostty" }, { TERM: "xterm-ghostty" }, {
      TERM: "xterm-kitty",
    }]
  ) {
    const get = (key: string) => (env as Record<string, string | undefined>)[key]
    assert(supportsKittyGraphics(true, get))
    assert(!supportsKittyGraphics(false, get))
  }
  for (
    const env of [
      {},
      { TERM: "xterm-256color" },
      { TERM_PROGRAM: "ghostty", TMUX: "/tmp/tmux" },
      { TERM_PROGRAM: "ghostty", STY: "screen" },
      { TERM_PROGRAM: "ghostty", TERM: "dumb" },
    ]
  ) {
    assert(
      !supportsKittyGraphics(
        true,
        (key) => (env as Record<string, string | undefined>)[key],
      ),
    )
  }
})

Deno.test("math delimiters render inside prose without consuming punctuation", async () => {
  for (
    const math of [
      String.raw`$\nu>0$`,
      "$f=0$",
      String.raw`\(x_i^2\)`,
      "$$x^2$$",
      String.raw`\[x^2\]`,
      String.raw`$\sim\$900$`,
    ]
  ) {
    const out = await renderMarkdown(`Before **${math}**, after.`, { math: true })
    assertEquals(imageCount(out), 1, math)
    assert(strip(out).startsWith("Before "))
    assert(strip(out).endsWith(", after."))
    assert(!/[\ue000-\uf8ff]/.test(out))
  }
})

Deno.test("math leaves currency, escaped dollars, and code alone", async () => {
  for (
    const text of [
      "between $50 to $100",
      "between $50-$100",
      "between $1,200-$1,500",
      "between $5 + $10",
      "**$30.7k** versus **$13.6k**",
      String.raw`\$not math$`,
      "`$x^2$`",
      "`` `$x^2$` ``",
      "```tex\n$x^2$\n```",
      "~~~tex\n$x^2$\n~~~",
      "    $x^2$",
      "[link](https://example.com/$x$)",
    ]
  ) {
    assertEquals(imageCount(await renderMarkdown(text, { math: true })), 0, text)
  }
})

Deno.test("disabled and invalid math preserve the raw TeX", async () => {
  for (
    const text of [
      String.raw`With $x_i^2$ and \(\nu>0\).`,
      "$$\nx_i^2\n$$",
      String.raw`\[x_i^2\]`,
    ]
  ) {
    assertEquals(strip(await renderMarkdown(text, { math: false })), text)
  }
  const invalid = String.raw`$\notARealCommand{$`
  assertEquals(strip(await renderMarkdown(invalid, { math: true })), invalid)
})

Deno.test("display math interrupts paragraphs and retains following text", async () => {
  const out = await renderMarkdown("Before\n$$\nx^2\n$$\nAfter", { math: true })
  assertEquals(imageCount(out), 1)
  assert(out.startsWith("Before\n\n"))
  assert(out.endsWith("\n\nAfter"))
})

Deno.test("math graphics survive wrapping, blockquotes, lists, and tables", async () => {
  for (
    const text of [
      "word ".repeat(20) + "$x^2$ after",
      "> $x^2$ and $y$",
      "> $$\n> x^2\n> $$",
      "- $x^2$\n- $y$",
      "| value |\n| --- |\n| $x^2$ |",
      "User private character: \ue000, then $x$ and $y$.",
    ]
  ) {
    const out = await renderMarkdown(text, { math: true })
    assert(imageCount(out) > 0, text)
    assert(!out.includes("\x00"), text)
    assert(!/[\ue001-\uf8ff]/.test(out), text)
    // Every APC is intact: wrapping must not insert a newline into its payload.
    for (const apc of out.matchAll(/\x1b_G([\s\S]*?)\x1b\\/g)) {
      assert(!apc[1].includes("\n"))
    }
  }
})

Deno.test("PNG chunks roundtrip and row placements reserve the correct cells", () => {
  const png = new Uint8Array(12000).map((_, i) => i % 256)
  const rows = kittyImage({ png, columns: 12, rows: 3, rowPixels: 60 }, 42)
  const chunks = [...rows[0].matchAll(/\x1b_G([^;]+);([^\x1b]*)\x1b\\/g)]
  assert(chunks.length > 1)
  assert(chunks.every((c) => c[2].length <= 4096 && c[2].length % 4 === 0))
  assert(chunks.slice(0, -1).every((c) => c[1].endsWith("m=1")))
  assert(chunks.at(-1)![1].endsWith("m=0"))
  assertEquals(decodeBase64(chunks.map((c) => c[2]).join("")), png)
  for (let row = 0; row < 3; row++) {
    assert(rows[row].includes(`C=1,y=${row * 60},h=60,c=12,r=1`))
    assert(rows[row].endsWith(" ".repeat(12)))
  }
})

Deno.test("MathJax rasterizes the example and constrains narrow/tall equations", async () => {
  const tex = String
    .raw`\partial_t u + (u\cdot\nabla)u = -\nabla p + \nu\Delta u + f, \qquad \nabla\cdot u = 0`
  for (const width of [20, 80]) {
    const image = await renderMathImage(tex, true, width, "#c8c8c8")
    assertEquals([...image.png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert(image.columns <= width)
    const header = new DataView(image.png.buffer, image.png.byteOffset)
    assertEquals(header.getUint32(16), image.columns * 30)
    assertEquals(header.getUint32(20), image.rows * image.rowPixels)
  }
  const tall = await renderMathImage(
    String.raw`\frac{\frac{a}{b}}{\frac{c}{d}}`,
    false,
    80,
    "#c8c8c8",
  )
  assertEquals(tall.rows, 1)
  await assertRejects(() => renderMathImage(String.raw`\invalid{`, false, 80, "#c8c8c8"))
})

Deno.test("SVG serialization escapes inequalities in MathJax attributes", async () => {
  const tex = String.raw`|x|=\begin{cases}-x & x<0\\x & x\geq0\end{cases}`
  const image = await renderMathImage(tex, true, 80, "#c8c8c8")
  assert(image.rows > 1)
  assertEquals(imageCount(await renderMarkdown(`$$\n${tex}\n$$`, { math: true })), 1)
})

Deno.test("the complete demo renders every valid equation", async () => {
  const text = await Deno.readTextFile(
    new URL("./fixtures/terminal-math.md", import.meta.url),
  )
  const output = await renderMarkdown(text, { math: true })
  assertEquals(imageCount(output), 31)
  assert(!output.includes(String.raw`\begin{bmatrix}`))
  assert(!output.includes(String.raw`\begin{cases}`))
  assert(!output.includes(String.raw`\begin{aligned}`))
  assert(output.includes(String.raw`\(\notARealCommand{x}\)`))
  assert(output.includes("$300-$500"))
})
