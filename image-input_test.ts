import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"

import { ValidationError } from "./errors.ts"
import { parseDataUrl, resolveImage, type SipsRunner } from "./image-input.ts"
import { errorIncluding } from "./testing.ts"

test("parseDataUrl - valid png data URL", () => {
  assert.deepEqual(parseDataUrl("data:image/png;base64,iVBORw0KGgo="), {
    mediaType: "image/png",
    data: "iVBORw0KGgo=",
  })
})

test("parseDataUrl - base64 payload with newlines", () => {
  // /s flag must be set on the regex so . matches newlines
  assert.deepEqual(parseDataUrl("data:image/jpeg;base64,AAAA\nBBBB\nCCCC"), {
    mediaType: "image/jpeg",
    data: "AAAA\nBBBB\nCCCC",
  })
})

test("parseDataUrl - non-data URL returns null", () => {
  assert.deepEqual(parseDataUrl("https://example.com/foo.png"), null)
})

test("parseDataUrl - missing base64 marker returns null", () => {
  assert.deepEqual(parseDataUrl("data:image/png,iVBORw0KGgo="), null)
})

test("parseDataUrl - empty string returns null", () => {
  assert.deepEqual(parseDataUrl(""), null)
})

test("resolveImage - http URL passes through", async () => {
  const url = "http://example.com/cat.png"
  assert.deepEqual(await resolveImage(url), url)
})

test("resolveImage - https URL passes through", async () => {
  const url = "https://example.com/cat.png"
  assert.deepEqual(await resolveImage(url), url)
})

async function withFakeSips(
  convert: SipsRunner,
  test: (input: string, calls: string[][], sips: SipsRunner) => Promise<void>,
  extension = "HEIC",
) {
  const dir = await mkdtemp(join(tmpdir(), "llm-sips-test-"))
  const input = join(dir, `phone photo.${extension}`)
  const calls: string[][] = []
  await writeFile(input, new Uint8Array([1, 2, 3]))
  const sips: SipsRunner = (args) => {
    calls.push(args)
    return convert(args)
  }
  try {
    await test(input, calls, sips)
  } finally {
    await rm(dir, { recursive: true })
  }
}

const commandOutput = (code = 0, stderr = "") => ({ code, stderr })

for (const extension of ["HEIC", "heif"]) {
  test(`resolveImage converts ${extension} to JPEG and cleans up without changing the original`, async () => {
    await withFakeSips(
      async (args) => {
        await writeFile(args.at(-1)!, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
        return commandOutput()
      },
      async (input, calls, sips) => {
        assert.deepEqual(await resolveImage(input, sips), "data:image/jpeg;base64,/9j/2Q==")
        assert.deepEqual(calls.length, 1)
        assert.deepEqual(calls[0].slice(0, -2), [
          "--setProperty",
          "format",
          "jpeg",
          "--setProperty",
          "formatOptions",
          "90",
          await realpath(input),
        ])
        assert.deepEqual(calls[0].at(-2), "--out")
        assert.deepEqual([...(await readFile(input))], [1, 2, 3])
        assert.deepEqual(existsSync(dirname(calls[0].at(-1)!)), false)
      },
      extension,
    )
  })
}

test("resolveImage explains missing sips and cleans up", async () => {
  await withFakeSips(
    () => Promise.reject(Object.assign(new Error("spawn sips ENOENT"), { code: "ENOENT" })),
    async (input, calls, sips) => {
      await assert.rejects(
        () => resolveImage(input, sips),
        errorIncluding(
          ValidationError,
          "HEIC conversion requires macOS's 'sips'. Convert the image to JPEG or PNG first.",
        ),
      )
      assert.deepEqual(calls.length, 1)
      assert.deepEqual(existsSync(dirname(calls[0].at(-1)!)), false)
    },
  )
})

test("resolveImage reports conversion failure and cleans up", async () => {
  await withFakeSips(
    () => Promise.resolve(commandOutput(13, "Invalid HEIC")),
    async (input, calls, sips) => {
      await assert.rejects(
        () => resolveImage(input, sips),
        errorIncluding(ValidationError, "Invalid HEIC"),
      )
      assert.deepEqual(calls.length, 1)
      assert.deepEqual(existsSync(dirname(calls[0].at(-1)!)), false)
    },
  )
})

test("resolveImage rejects incomplete sips output even when the process succeeds", async () => {
  await withFakeSips(
    async (args) => {
      await writeFile(args.at(-1)!, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))
      return commandOutput()
    },
    async (input, calls, sips) => {
      await assert.rejects(
        () => resolveImage(input, sips),
        errorIncluding(ValidationError, "incomplete JPEG"),
      )
      assert.deepEqual(calls.length, 1)
      assert.deepEqual(existsSync(dirname(calls[0].at(-1)!)), false)
    },
  )
})

test("resolveImage reports missing converter output and cleans up", async () => {
  await withFakeSips(
    () => Promise.resolve(commandOutput()),
    async (input, calls, sips) => {
      await assert.rejects(
        () => resolveImage(input, sips),
        errorIncluding(ValidationError, "did not produce a JPEG"),
      )
      assert.deepEqual(calls.length, 1)
      assert.deepEqual(existsSync(dirname(calls[0].at(-1)!)), false)
    },
  )
})

test("resolveImage leaves ordinary local images unchanged without invoking sips", async () => {
  await withFakeSips(
    () => Promise.reject(new Error("Should not run sips")),
    async (input, calls, sips) => {
      assert.deepEqual(await resolveImage(input, sips), "data:image/png;base64,AQID")
      assert.deepEqual(calls.length, 0)
    },
    "png",
  )
})
