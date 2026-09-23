// deno-lint-ignore-file no-control-regex
import { assert, assertEquals } from "@std/assert"
import {
  imageColumns,
  kittyPng,
  pngDimensions,
  supportsKittyGraphics,
} from "./terminal-image.ts"

/** Minimal PNG header: signature plus IHDR width and height. Enough for sizing. */
function fakePng(width: number, height: number, extra = 0) {
  const bytes = new Uint8Array(24 + extra)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

Deno.test("pngDimensions reads IHDR", () => {
  assertEquals(pngDimensions(fakePng(1536, 1024)), { width: 1536, height: 1024 })
})

Deno.test("imageColumns caps at 80 and fits the screen height", () => {
  const term = { columns: 200, rows: 100 }
  assertEquals(imageColumns(fakePng(1024, 1024), term), 80)
  // 44 usable rows × 2 cells tall per column → 88 columns for a square image
  assertEquals(imageColumns(fakePng(1024, 1024), { columns: 200, rows: 48 }), 80)
  assertEquals(imageColumns(fakePng(1024, 1024), { columns: 200, rows: 24 }), 40)
  assertEquals(imageColumns(fakePng(1024, 1024), { columns: 30, rows: 100 }), 30)
  // portrait: 20 rows × 2 × (1024/1536) = 26.67
  assertEquals(imageColumns(fakePng(1024, 1536), { columns: 200, rows: 24 }), 26)
})

Deno.test("kittyPng places in one command with chunked payload", () => {
  const out = kittyPng(fakePng(10, 10, 9000), 40)
  const chunks = [...out.matchAll(/\x1b_G([^;]*);/g)].map((m) => m[1])
  assertEquals(chunks[0], "a=T,f=100,t=d,q=2,c=40,m=1")
  assertEquals(chunks.slice(1), ["q=2,m=1", "q=2,m=0"])
  assertEquals(out.at(-1), "\n")
})

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
