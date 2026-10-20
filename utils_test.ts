import { assertEquals, assertRejects, assertThrows } from "@std/assert"
import { ValidationError } from "./errors.ts"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parseDataUrl, parseMessageSpec, resolveImage, type SipsRunner } from "./utils.ts"

Deno.test("parseMessageSpec - single number", () => {
  assertEquals(parseMessageSpec("3", 5), [2])
})

Deno.test("parseMessageSpec - multiple numbers", () => {
  assertEquals(parseMessageSpec("1,3,5", 5), [0, 2, 4])
})

Deno.test("parseMessageSpec - range", () => {
  assertEquals(parseMessageSpec("2-4", 5), [1, 2, 3])
})

Deno.test("parseMessageSpec - mixed numbers and ranges", () => {
  assertEquals(parseMessageSpec("1,3-4,7", 10), [0, 2, 3, 6])
})

Deno.test("parseMessageSpec - even keyword", () => {
  // 1-based even message numbers 2,4,6 -> 0-based
  assertEquals(parseMessageSpec("even", 6), [1, 3, 5])
})

Deno.test("parseMessageSpec - odd keyword", () => {
  // 1-based odd message numbers 1,3,5 -> 0-based
  assertEquals(parseMessageSpec("odd", 6), [0, 2, 4])
})

Deno.test("parseMessageSpec - even/odd combine with numbers and dedupe", () => {
  assertEquals(parseMessageSpec("odd,2", 5), [0, 1, 2, 4])
})

Deno.test("parseMessageSpec - out of order input returns sorted", () => {
  assertEquals(parseMessageSpec("7,1,3-4", 10), [0, 2, 3, 6])
})

Deno.test("parseMessageSpec - duplicates are deduplicated", () => {
  assertEquals(parseMessageSpec("1,1,2-3,3", 5), [0, 1, 2])
})

Deno.test("parseMessageSpec - whitespace is tolerated", () => {
  assertEquals(parseMessageSpec(" 1 , 3 - 4 , 7 ", 10), [0, 2, 3, 6])
})

Deno.test("parseMessageSpec - range start > end throws", () => {
  assertThrows(
    () => parseMessageSpec("4-2", 5),
    ValidationError,
    "Invalid range: start > end",
  )
})

Deno.test("parseMessageSpec - message number too high throws", () => {
  assertThrows(
    () => parseMessageSpec("1,10", 5),
    ValidationError,
    "Message 10 does not exist (chat has 5 messages)",
  )
})

Deno.test("parseMessageSpec - message number 0 throws", () => {
  assertThrows(
    () => parseMessageSpec("0", 5),
    ValidationError,
    "Message 0 does not exist",
  )
})

Deno.test("parseMessageSpec - invalid number throws", () => {
  assertThrows(
    () => parseMessageSpec("abc", 5),
    ValidationError,
    "Invalid message number",
  )
})

Deno.test("parseMessageSpec - invalid number suffix throws", () => {
  assertThrows(
    () => parseMessageSpec("1abc", 5),
    ValidationError,
    'Invalid message number: "1abc"',
  )
})

Deno.test("parseMessageSpec - decimal number throws", () => {
  assertThrows(
    () => parseMessageSpec("1.5", 5),
    ValidationError,
    'Invalid message number: "1.5"',
  )
})

Deno.test("parseMessageSpec - invalid range throws", () => {
  assertThrows(
    () => parseMessageSpec("a-b", 5),
    ValidationError,
    "Invalid range",
  )
})

Deno.test("parseMessageSpec - invalid range suffix throws", () => {
  assertThrows(
    () => parseMessageSpec("1-2-3", 5),
    ValidationError,
    'Invalid range: "1-2-3"',
  )
})

Deno.test("parseDataUrl - valid png data URL", () => {
  assertEquals(
    parseDataUrl("data:image/png;base64,iVBORw0KGgo="),
    { mediaType: "image/png", data: "iVBORw0KGgo=" },
  )
})

Deno.test("parseDataUrl - base64 payload with newlines", () => {
  // /s flag must be set on the regex so . matches newlines
  assertEquals(
    parseDataUrl("data:image/jpeg;base64,AAAA\nBBBB\nCCCC"),
    { mediaType: "image/jpeg", data: "AAAA\nBBBB\nCCCC" },
  )
})

Deno.test("parseDataUrl - non-data URL returns null", () => {
  assertEquals(parseDataUrl("https://example.com/foo.png"), null)
})

Deno.test("parseDataUrl - missing base64 marker returns null", () => {
  assertEquals(parseDataUrl("data:image/png,iVBORw0KGgo="), null)
})

Deno.test("parseDataUrl - empty string returns null", () => {
  assertEquals(parseDataUrl(""), null)
})

Deno.test("resolveImage - http URL passes through", async () => {
  const url = "http://example.com/cat.png"
  assertEquals(await resolveImage(url), url)
})

Deno.test("resolveImage - https URL passes through", async () => {
  const url = "https://example.com/cat.png"
  assertEquals(await resolveImage(url), url)
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
      assertEquals(await resolveImage(input, sips), "data:image/jpeg;base64,/9j/2Q==")
      assertEquals(calls.length, 1)
      assertEquals(calls[0].slice(0, -2), [
        "--setProperty",
        "format",
        "jpeg",
        "--setProperty",
        "formatOptions",
        "90",
        await realpath(input),
      ])
      assertEquals(calls[0].at(-2), "--out")
      assertEquals([...await readFile(input)], [1, 2, 3])
      assertEquals(existsSync(dirname(calls[0].at(-1)!)), false)
    }, extension)
  })
}

Deno.test("resolveImage explains missing sips and cleans up", async () => {
  await withFakeSips(
    () => Promise.reject(Object.assign(new Error("spawn sips ENOENT"), { code: "ENOENT" })),
    async (input, calls, sips) => {
      await assertRejects(
        () => resolveImage(input, sips),
        ValidationError,
        "HEIC conversion requires macOS's 'sips'. Convert the image to JPEG or PNG first.",
      )
      assertEquals(calls.length, 1)
      assertEquals(existsSync(dirname(calls[0].at(-1)!)), false)
    },
  )
})

Deno.test("resolveImage reports conversion failure and cleans up", async () => {
  await withFakeSips(
    () => Promise.resolve(commandOutput(13, "Invalid HEIC")),
    async (input, calls, sips) => {
      await assertRejects(() => resolveImage(input, sips), ValidationError, "Invalid HEIC")
      assertEquals(calls.length, 1)
      assertEquals(existsSync(dirname(calls[0].at(-1)!)), false)
    },
  )
})

Deno.test("resolveImage rejects incomplete sips output even when the process succeeds", async () => {
  await withFakeSips(async (args) => {
    await writeFile(args.at(-1)!, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))
    return commandOutput()
  }, async (input, calls, sips) => {
    await assertRejects(() => resolveImage(input, sips), ValidationError, "incomplete JPEG")
    assertEquals(calls.length, 1)
    assertEquals(existsSync(dirname(calls[0].at(-1)!)), false)
  })
})

Deno.test("resolveImage reports missing converter output and cleans up", async () => {
  await withFakeSips(() => Promise.resolve(commandOutput()), async (input, calls, sips) => {
    await assertRejects(
      () => resolveImage(input, sips),
      ValidationError,
      "did not produce a JPEG",
    )
    assertEquals(calls.length, 1)
    assertEquals(existsSync(dirname(calls[0].at(-1)!)), false)
  })
})

Deno.test("resolveImage leaves ordinary local images unchanged without invoking sips", async () => {
  await withFakeSips(
    () => Promise.reject(new Error("Should not run sips")),
    async (input, calls, sips) => {
      assertEquals(await resolveImage(input, sips), "data:image/png;base64,AQID")
      assertEquals(calls.length, 0)
    },
    "png",
  )
})
