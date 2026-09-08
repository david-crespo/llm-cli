import { mathjax } from "@mathjax/src/js/mathjax.js"
import { TeX } from "@mathjax/src/js/input/tex.js"
import { SVG } from "@mathjax/src/js/output/svg.js"
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js"
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js"
import "@mathjax/src/js/util/asyncLoad/esm.js"
import "@mathjax/src/js/input/tex/base/BaseConfiguration.js"
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js"
import "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js"
import { initWasm, Resvg } from "@resvg/resvg-wasm"

const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor)
let wasm: Promise<void> | undefined

export type MathImage = {
  png: Uint8Array
  columns: number
  rows: number
  rowPixels: number
}

/** Render at 3x resolution; placement sizes are expressed in terminal cells. */
export async function renderMathImage(
  latex: string,
  display: boolean,
  maxColumns: number,
  color: string,
): Promise<MathImage> {
  await (wasm ??= initWasm(
    Deno.readFile(new URL(import.meta.resolve("@resvg/resvg-wasm/index_bg.wasm"))),
  ))
  // A document per expression prevents user-defined macros leaking between messages.
  const doc = mathjax.document("", {
    InputJax: new TeX({ packages: ["base", "ams", "newcommand"] }),
    OutputJax: new SVG({ fontCache: "none", linebreaks: { inline: false } }),
  })
  const node = await mathjax.handleRetriesFor(() => doc.convert(latex, { display }))
  // resvg parses XML; HTML serialization leaves '<' in data-latex attributes.
  const markup = adaptor.serializeXML(node)
  if (markup.includes('data-mml-node="merror"')) throw new Error("Invalid TeX")
  const svg = markup.match(/<svg\b[\s\S]*<\/svg>/)?.[0]
  const viewBox = svg?.match(/viewBox="([^"]+)"/)?.[1].split(/\s+/).map(Number)
  if (!svg || !viewBox || viewBox.length !== 4) throw new Error("Missing math SVG")
  const [x, y, width, height] = viewBox
  if (!(width > 0 && height > 0)) throw new Error("Empty math SVG")

  // Nominal 10x20 cells. Pad to whole cells so scaling does not stretch the formula.
  const inlineBaseline = 16
  const horizontalPadding = display ? 4 : 0
  const scale = Math.min(
    (display ? 20 : 16) / 1000,
    (maxColumns * 10 - horizontalPadding) / width,
    display ? 300 / height : Math.min(
      inlineBaseline / Math.max(1, -y),
      (20 - inlineBaseline) / Math.max(1, y + height),
    ),
  )
  const columns = Math.max(1, Math.ceil((width * scale + horizontalPadding) / 10))
  const rows = display ? Math.max(1, Math.ceil((height * scale + 4) / 20)) : 1
  const pixelWidth = columns * 30
  const pixelHeight = rows * 60
  const inner = svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"))
  const offsetX = display ? 2 : (columns * 10 - width * scale) / 2
  // MathJax's SVG baseline is y=0. Align it with the text baseline rather than
  // centering each glyph's bounds; short letters such as nu otherwise float.
  const offsetY = display ? (rows * 20 - height * scale) / 2 : inlineBaseline + y * scale
  const padded =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelWidth}" height="${pixelHeight}" viewBox="0 0 ${
      columns * 10
    } ${
      rows * 20
    }" color="${color}"><g transform="translate(${offsetX} ${offsetY}) scale(${scale}) translate(${-x} ${-y})">${inner}</g></svg>`
  const renderer = new Resvg(padded)
  try {
    const rendered = renderer.render()
    try {
      return { png: rendered.asPng(), columns, rows, rowPixels: 60 }
    } finally {
      rendered.free()
    }
  } finally {
    renderer.free()
  }
}
