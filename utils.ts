import { ValidationError } from "./errors.ts"
import { Buffer } from "node:buffer"
import { join } from "node:path"
import $ from "dax"
import * as R from "remeda"

const parsePart = (part: string, msgCount: number): number[] => {
  if (part === "even" || part === "odd") {
    const start = part === "even" ? 2 : 1
    return R.range(start, msgCount + 1).filter((n) => n % 2 === (part === "even" ? 0 : 1))
  }

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
 * Message numbers in the spec are 1-based (user-facing). The keywords "even"
 * and "odd" expand to all even/odd message numbers.
 * Throws if a range has start > end or if any number is out of bounds.
 */
export function parseMessageSpec(spec: string, msgCount: number): number[] {
  const indices = R.pipe(
    spec.replaceAll(" ", "").split(","),
    R.filter((p) => p.length > 0),
    R.flatMap((part) => parsePart(part, msgCount)),
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

/** Convert a local HEIC/HEIF through macOS's optional image converter. */
async function convertHeicImage(value: string): Promise<Uint8Array> {
  let sourcePath: string
  try {
    sourcePath = await Deno.realPath(value)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new ValidationError(`Could not read image at '${value}': ${msg}`)
  }
  const tmpDir = await Deno.makeTempDir({
    dir: Deno.build.os === "darwin" ? "/tmp" : undefined,
    prefix: "llm-heic-",
  })
  try {
    const outputPath = join(tmpDir, "converted.jpg")
    let result: Deno.CommandOutput
    try {
      result = await new Deno.Command("sips", {
        args: [
          "--setProperty",
          "format",
          "jpeg",
          "--setProperty",
          "formatOptions",
          "90",
          sourcePath,
          "--out",
          outputPath,
        ],
        stdout: "null",
        stderr: "piped",
      }).output()
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        throw new ValidationError(
          "HEIC conversion requires macOS's 'sips'. Convert the image to JPEG or PNG first.",
        )
      }
      throw e
    }
    if (!result.success) {
      const error = new TextDecoder().decode(result.stderr).trim() || `exit ${result.code}`
      throw new ValidationError(`Could not convert HEIC image at '${value}': ${error}`)
    }
    let bytes: Uint8Array
    try {
      bytes = await Deno.readFile(outputPath)
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        throw new ValidationError(
          `Could not convert HEIC image at '${value}': sips did not produce a JPEG`,
        )
      }
      throw e
    }
    // sips can exit successfully after writing only JPEG headers if encoding fails.
    if (
      bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
      bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9
    ) {
      throw new ValidationError(
        `Could not convert HEIC image at '${value}': incomplete JPEG`,
      )
    }
    return bytes
  } finally {
    await Deno.remove(tmpDir, { recursive: true })
  }
}

/**
 * Resolve `--image <value>` to a URL string. The sentinel `clipboard` pulls a
 * PNG from the macOS clipboard. `http(s)` URLs pass through. Any other value
 * is treated as a local file path, read, base64-encoded, and returned as a
 * `data:` URL. Local HEIC/HEIF files are converted to JPEG through `sips`.
 */
export async function resolveImage(value: string): Promise<string> {
  if (value === "clipboard") {
    const bytes = await readClipboardImage()
    return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`
  }
  if (/^https?:\/\//i.test(value)) return value

  const ext = value.split(".").pop()?.toLowerCase() ?? ""
  if (ext === "heic" || ext === "heif") {
    const bytes = await convertHeicImage(value)
    return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`
  }

  let bytes: Uint8Array
  try {
    bytes = await Deno.readFile(value)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new ValidationError(`Could not read image at '${value}': ${msg}`)
  }
  const mediaType = EXT_MIME[ext]
  if (!mediaType) {
    throw new ValidationError(
      `Unsupported image extension '.${ext}'. Supported: ${
        [...Object.keys(EXT_MIME), "heic/heif (requires sips)"].join(", ")
      }`,
    )
  }
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`
}
