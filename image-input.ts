import { Buffer } from "node:buffer"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import $ from "dax"

import { isErrno, ValidationError } from "./errors.ts"

const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number]

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
  if (process.platform !== "darwin") {
    throw new ValidationError("Clipboard image paste is only supported on macOS")
  }
  const tmpPath = join(tmpdir(), `llm-clipboard-${crypto.randomUUID()}.png`)
  const file = JSON.stringify(tmpPath)
  try {
    const result = await $`osascript \
      -e ${`set png_data to (the clipboard as «class PNGf»)`} \
      -e ${`set f to open for access POSIX file ${file} with write permission`} \
      -e ${`set eof f to 0`} \
      -e ${`write png_data to f`} \
      -e ${`close access f`}`
      .stderr("piped")
      .noThrow()
    if (result.code !== 0) {
      // osascript -1700 = "can't make ... into type PNGf" → no image on clipboard
      const noImage = /-1700|class PNGf/.test(result.stderr)
      throw new ValidationError(
        noImage
          ? "No image found in clipboard"
          : `osascript failed: ${result.stderr.trim()}`,
      )
    }
    return await readFile(tmpPath)
  } finally {
    await rm(tmpPath, { force: true })
  }
}

/** Runs `sips` with the given args. Rejects only if it can't be started. */
export type SipsRunner = (args: string[]) => Promise<{ code: number; stderr: string }>

const execSips: SipsRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile("sips", args, (error, _stdout, stderr) => {
      // A string code like ENOENT means the process never ran.
      if (typeof error?.code === "string") reject(error)
      else resolve({ code: error ? (error.code ?? 1) : 0, stderr })
    })
  })

/** Convert a local HEIC/HEIF through macOS's optional image converter. */
async function convertHeicImage(value: string, runSips: SipsRunner): Promise<Uint8Array> {
  let sourcePath: string
  try {
    sourcePath = await realpath(value)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new ValidationError(`Could not read image at '${value}': ${msg}`)
  }
  const tmpDir = await mkdtemp(join(tmpdir(), "llm-heic-"))
  try {
    const outputPath = join(tmpDir, "converted.jpg")
    let result: Awaited<ReturnType<SipsRunner>>
    try {
      result = await runSips([
        "--setProperty",
        "format",
        "jpeg",
        "--setProperty",
        "formatOptions",
        "90",
        sourcePath,
        "--out",
        outputPath,
      ])
    } catch (e) {
      if (isErrno(e, "ENOENT")) {
        throw new ValidationError(
          "HEIC conversion requires macOS's 'sips'. Convert the image to JPEG or PNG first.",
        )
      }
      throw e
    }
    if (result.code !== 0) {
      const error = result.stderr.trim() || `exit ${result.code}`
      throw new ValidationError(`Could not convert HEIC image at '${value}': ${error}`)
    }
    let bytes: Uint8Array
    try {
      bytes = await readFile(outputPath)
    } catch (e) {
      if (isErrno(e, "ENOENT")) {
        throw new ValidationError(
          `Could not convert HEIC image at '${value}': sips did not produce a JPEG`,
        )
      }
      throw e
    }
    // sips can exit successfully after writing only JPEG headers if encoding fails.
    if (
      bytes.length < 4 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes.at(-2) !== 0xff ||
      bytes.at(-1) !== 0xd9
    ) {
      throw new ValidationError(
        `Could not convert HEIC image at '${value}': incomplete JPEG`,
      )
    }
    return bytes
  } finally {
    await rm(tmpDir, { recursive: true })
  }
}

/**
 * Resolve `--image <value>` to a URL string. The sentinel `clipboard` pulls a
 * PNG from the macOS clipboard. `http(s)` URLs pass through. Any other value
 * is treated as a local file path, read, base64-encoded, and returned as a
 * `data:` URL. Local HEIC/HEIF files are converted to JPEG through `sips`.
 */
export async function resolveImage(
  value: string,
  runSips: SipsRunner = execSips,
): Promise<string> {
  if (value === "clipboard") {
    const bytes = await readClipboardImage()
    return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`
  }
  if (/^https?:\/\//i.test(value)) return value

  const ext = value.split(".").pop()?.toLowerCase() ?? ""
  if (ext === "heic" || ext === "heif") {
    const bytes = await convertHeicImage(value, runSips)
    return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`
  }

  let bytes: Uint8Array
  try {
    bytes = await readFile(value)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new ValidationError(`Could not read image at '${value}': ${msg}`)
  }
  const mediaType = EXT_MIME[ext]
  if (!mediaType) {
    throw new ValidationError(
      `Unsupported image extension '.${ext}'. Supported: ${[
        ...Object.keys(EXT_MIME),
        "heic/heif (requires sips)",
      ].join(", ")}`,
    )
  }
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`
}
