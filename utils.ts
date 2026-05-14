import { ValidationError } from "@cliffy/command"
import { encodeBase64 } from "@std/encoding/base64"
import $ from "@david/dax"
import * as R from "remeda"

const parsePart = (part: string): number[] => {
  if (/^\d+-\d+$/.test(part)) {
    const [startStr, endStr] = part.split("-")
    const start = Number(startStr)
    const end = Number(endStr)
    if (start > end) {
      throw new ValidationError(`Invalid range: start > end in "${part}"`)
    }
    return R.range(start, end + 1)
  }

  if (/^\d+$/.test(part)) {
    return [Number(part)]
  }

  throw new ValidationError(
    part.includes("-") ? `Invalid range: "${part}"` : `Invalid message number: "${part}"`,
  )
}

/**
 * Parse a message spec like "1,3-4,7" into a sorted array of 0-based indices.
 * Message numbers in the spec are 1-based (user-facing).
 * Throws if a range has start > end or if any number is out of bounds.
 */
export function parseMessageSpec(spec: string, msgCount: number): number[] {
  const indices = R.pipe(
    spec.replaceAll(" ", "").split(","),
    R.filter((p) => p.length > 0),
    R.flatMap(parsePart),
    R.unique(),
    R.sortBy(R.identity()),
  )

  for (const num of indices) {
    if (num < 1 || num > msgCount) {
      throw new ValidationError(
        `Message ${num} does not exist (chat has ${msgCount} messages)`,
      )
    }
  }

  return R.map(indices, (n) => n - 1) // make 0-indexed
}

const IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const
export type ImageMimeType = typeof IMAGE_MIME_TYPES[number]

function isImageMimeType(s: string): s is ImageMimeType {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(s)
}

const EXT_MIME: Record<string, ImageMimeType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

/** Parse a data URL into image media type and raw base64 payload, or null.
 * Returns null for non-data URLs or unsupported media types. */
export function parseDataUrl(
  url: string,
): { mediaType: ImageMimeType; data: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(url)
  if (!m || !isImageMimeType(m[1])) return null
  return { mediaType: m[1], data: m[2] }
}

/**
 * Read a PNG image from the macOS clipboard via `osascript`. The clipboard
 * lives in NSPasteboard, so we have to go through an OS-level helper; we use
 * osascript because it ships with macOS (no install step). Returns the raw
 * bytes; only PNG is supported, which covers screenshots and browser
 * "copy image" out of the box.
 */
async function readClipboardImage(): Promise<Uint8Array> {
  if (Deno.build.os !== "darwin") {
    throw new ValidationError(
      "Clipboard image paste is only supported on macOS",
    )
  }
  // Pinned to /tmp so the shebang can scope --allow-write narrowly. Deno's
  // default temp dir on macOS is $TMPDIR (/var/folders/...), which can't be
  // expressed statically in a shebang.
  const tmpPath = await Deno.makeTempFile({ dir: "/tmp", suffix: ".png" })
  try {
    const result = await $`osascript \
      -e ${`set png_data to (the clipboard as «class PNGf»)`} \
      -e ${`set f to open for access POSIX file ${
      JSON.stringify(tmpPath)
    } with write permission`} \
      -e ${`set eof f to 0`} \
      -e ${`write png_data to f`} \
      -e ${`close access f`}`
      .stderr("piped").noThrow()
    if (result.code !== 0) {
      // osascript -1700 = "can't make ... into type PNGf" → no image on clipboard
      const noImage = /-1700|class PNGf/.test(result.stderr)
      throw new ValidationError(
        noImage
          ? "No image found in clipboard"
          : `osascript failed: ${result.stderr.trim()}`,
      )
    }
    return await Deno.readFile(tmpPath)
  } finally {
    await Deno.remove(tmpPath).catch(() => {})
  }
}

/**
 * Resolve `--image <value>` to a URL string. The sentinel `clipboard` pulls a
 * PNG from the macOS clipboard. `http(s)` URLs pass through. Any other value
 * is treated as a local file path, read, base64-encoded, and returned as a
 * `data:` URL.
 */
export async function resolveImage(value: string): Promise<string> {
  if (value === "clipboard") {
    const bytes = await readClipboardImage()
    return `data:image/png;base64,${encodeBase64(bytes)}`
  }
  if (/^https?:\/\//i.test(value)) return value

  let bytes: Uint8Array
  try {
    bytes = await Deno.readFile(value)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new ValidationError(`Could not read image at '${value}': ${msg}`)
  }
  const ext = value.split(".").pop()?.toLowerCase() ?? ""
  const mediaType = EXT_MIME[ext]
  if (!mediaType) {
    throw new ValidationError(
      `Unsupported image extension '.${ext}'. Supported: ${
        Object.keys(EXT_MIME).join(", ")
      }`,
    )
  }
  return `data:${mediaType};base64,${encodeBase64(bytes)}`
}
