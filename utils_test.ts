import assert from "node:assert/strict"
import { errorIncluding } from "./testing.ts"
import { ValidationError } from "./errors.ts"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parseDataUrl, parseMessageSpec, resolveImage, type SipsRunner } from "./utils.ts"

Deno.test("parseMessageSpec - single number", () => {
  assert.deepEqual(parseMessageSpec("3", 5), [2])
})

Deno.test("parseMessageSpec - multiple numbers", () => {
  assert.deepEqual(parseMessageSpec("1,3,5", 5), [0, 2, 4])
})

Deno.test("parseMessageSpec - range", () => {
  assert.deepEqual(parseMessageSpec("2-4", 5), [1, 2, 3])
})

Deno.test("parseMessageSpec - mixed numbers and ranges", () => {
  assert.deepEqual(parseMessageSpec("1,3-4,7", 10), [0, 2, 3, 6])
})

Deno.test("parseMessageSpec - even keyword", () => {
  // 1-based even message numbers 2,4,6 -> 0-based
  assert.deepEqual(parseMessageSpec("even", 6), [1, 3, 5])
})

Deno.test("parseMessageSpec - odd keyword", () => {
  // 1-based odd message numbers 1,3,5 -> 0-based
  assert.deepEqual(parseMessageSpec("odd", 6), [0, 2, 4])
})

Deno.test("parseMessageSpec - even/odd combine with numbers and dedupe", () => {
  assert.deepEqual(parseMessageSpec("odd,2", 5), [0, 1, 2, 4])
})

Deno.test("parseMessageSpec - out of order input returns sorted", () => {
  assert.deepEqual(parseMessageSpec("7,1,3-4", 10), [0, 2, 3, 6])
})

Deno.test("parseMessageSpec - duplicates are deduplicated", () => {
  assert.deepEqual(parseMessageSpec("1,1,2-3,3", 5), [0, 1, 2])
})

Deno.test("parseMessageSpec - whitespace is tolerated", () => {
  assert.deepEqual(parseMessageSpec(" 1 , 3 - 4 , 7 ", 10), [0, 2, 3, 6])
})

Deno.test("parseMessageSpec - range start > end throws", () => {
  assert.throws(
    () => parseMessageSpec("4-2", 5),
    errorIncluding(ValidationError, "Invalid range: start > end"),
  )
})

Deno.test("parseMessageSpec - message number too high throws", () => {
  assert.throws(
    () => parseMessageSpec("1,10", 5),
    errorIncluding(ValidationError, "Message 10 does not exist (chat has 5 messages)"),
  )
})

Deno.test("parseMessageSpec - message number 0 throws", () => {
  assert.throws(
    () => parseMessageSpec("0", 5),
    errorIncluding(ValidationError, "Message 0 does not exist"),
  )
})

Deno.test("parseMessageSpec - invalid number throws", () => {
  assert.throws(
    () => parseMessageSpec("abc", 5),
    errorIncluding(ValidationError, "Invalid message number"),
  )
})

Deno.test("parseMessageSpec - invalid number suffix throws", () => {
  assert.throws(
    () => parseMessageSpec("1abc", 5),
    errorIncluding(ValidationError, 'Invalid message number: "1abc"'),
  )
})

Deno.test("parseMessageSpec - decimal number throws", () => {
  assert.throws(
    () => parseMessageSpec("1.5", 5),
    errorIncluding(ValidationError, 'Invalid message number: "1.5"'),
  )
})

Deno.test("parseMessageSpec - invalid range throws", () => {
  assert.throws(
    () => parseMessageSpec("a-b", 5),
    errorIncluding(ValidationError, "Invalid range"),
  )
})

Deno.test("parseMessageSpec - invalid range suffix throws", () => {
  assert.throws(
    () => parseMessageSpec("1-2-3", 5),
    errorIncluding(ValidationError, 'Invalid range: "1-2-3"'),
  )
})

Deno.test("parseDataUrl - valid png data URL", () => {
  assert.deepEqual(parseDataUrl("data:image/png;base64,iVBORw0KGgo="), {
    mediaType: "image/png",
    data: "iVBORw0KGgo=",
  })
})

Deno.test("parseDataUrl - base64 payload with newlines", () => {
  // /s flag must be set on the regex so . matches newlines
  assert.deepEqual(parseDataUrl("data:image/jpeg;base64,AAAA\nBBBB\nCCCC"), {
    mediaType: "image/jpeg",
    data: "AAAA\nBBBB\nCCCC",
  })
})

Deno.test("parseDataUrl - non-data URL returns null", () => {
  assert.deepEqual(parseDataUrl("https://example.com/foo.png"), null)
})

Deno.test("parseDataUrl - missing base64 marker returns null", () => {
  assert.deepEqual(parseDataUrl("data:image/png,iVBORw0KGgo="), null)
})

Deno.test("parseDataUrl - empty string returns null", () => {
  assert.deepEqual(parseDataUrl(""), null)
})

Deno.test("resolveImage - http URL passes through", async () => {
  const url = "http://example.com/cat.png"
  assert.deepEqual(await resolveImage(url), url)
})

Deno.test("resolveImage - https URL passes through", async () => {
  const url = "https://example.com/cat.png"
  assert.deepEqual(await resolveImage(url), url)
})

async function withFakeSips(
  convert: SipsRunner,
  test: (input: string, calls: string[][], sips: SipsRunner) => Promise<void>,
  extension = "HEIC",
) {
  const dir = await mkdtemp("/tmp/llm-sips-test-")
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
  Deno.test(`resolveImage converts ${extension} to JPEG and cleans up without changing the original`, async () => {
    await withFakeSips(async (args) => {
      await writeFile(args.at(-1)!, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
      return commandOutput()
    }, async (input, calls, sips) => {
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
      assert.deepEqual([...await readFile(input)], [1, 2, 3])
      assert.deepEqual(existsSync(dirname(calls[0].at(-1)!)), false)
    }, extension)
  })
}

Deno.test("resolveImage explains missing sips and cleans up", async () => {
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

Deno.test("resolveImage reports conversion failure and cleans up", async () => {
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

Deno.test("resolveImage rejects incomplete sips output even when the process succeeds", async () => {
  await withFakeSips(async (args) => {
    await writeFile(args.at(-1)!, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))
    return commandOutput()
  }, async (input, calls, sips) => {
    await assert.rejects(
      () => resolveImage(input, sips),
      errorIncluding(ValidationError, "incomplete JPEG"),
    )
    assert.deepEqual(calls.length, 1)
    assert.deepEqual(existsSync(dirname(calls[0].at(-1)!)), false)
  })
})

Deno.test("resolveImage reports missing converter output and cleans up", async () => {
  await withFakeSips(() => Promise.resolve(commandOutput()), async (input, calls, sips) => {
    await assert.rejects(
      () => resolveImage(input, sips),
      errorIncluding(ValidationError, "did not produce a JPEG"),
    )
    assert.deepEqual(calls.length, 1)
    assert.deepEqual(existsSync(dirname(calls[0].at(-1)!)), false)
  })
})

Deno.test("resolveImage leaves ordinary local images unchanged without invoking sips", async () => {
  await withFakeSips(
    () => Promise.reject(new Error("Should not run sips")),
    async (input, calls, sips) => {
      assert.deepEqual(await resolveImage(input, sips), "data:image/png;base64,AQID")
      assert.deepEqual(calls.length, 0)
    },
    "png",
  )
})
