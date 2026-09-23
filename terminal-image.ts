import { encodeBase64 } from "@std/encoding/base64"

export function supportsKittyGraphics(
  isTerminal = Deno.stdout.isTerminal(),
  env: (key: string) => string | undefined = (key) => Deno.env.get(key),
): boolean {
  if (!isTerminal || env("TMUX") || env("STY") || env("TERM") === "dumb") return false
  return env("TERM_PROGRAM") === "ghostty" ||
    ["xterm-ghostty", "xterm-kitty"].includes(env("TERM") ?? "")
}

/**
 * Transmit a PNG with the Kitty graphics protocol, chunked as the spec requires.
 * `control` holds the keys for the first chunk (e.g. `a=T,f=100`); later
 * chunks carry only `m` and `q`. PNG transmission uses only direct data, so it
 * also works over SSH.
 */
export function kittyTransmit(png: Uint8Array, control: string): string {
  const payload = encodeBase64(png)
  let out = ""
  for (let offset = 0; offset < payload.length; offset += 4096) {
    const more = offset + 4096 < payload.length ? 1 : 0
    const params = offset === 0 ? `${control},` : "q=2,"
    out += `\x1b_G${params}m=${more};${payload.slice(offset, offset + 4096)}\x1b\\`
  }
  return out
}

/** Read width and height from a PNG's IHDR chunk. */
export function pngDimensions(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

type TermSize = { columns: number; rows: number }

/**
 * Width in cells for showing an image inline: at most 80 columns, and short
 * enough to fit on screen assuming cells are about twice as tall as wide.
 */
export function imageColumns(png: Uint8Array, term: TermSize): number {
  const { width, height } = pngDimensions(png)
  const fitHeight = Math.floor((term.rows - 4) * 2 * width / height)
  return Math.max(1, Math.min(term.columns, 80, fitHeight))
}

/**
 * Transmit and place a PNG at the cursor in one step. Only the column count is
 * given, so the terminal derives rows from the aspect ratio. The cursor ends
 * up on the image's last row, hence the newline.
 */
export function kittyPng(png: Uint8Array, columns: number): string {
  return kittyTransmit(png, `a=T,f=100,t=d,q=2,c=${columns}`) + "\n"
}
