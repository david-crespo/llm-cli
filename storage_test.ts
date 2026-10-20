import { assertEquals, assertThrows } from "@std/assert"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { History, imageFilename, saveImage } from "./storage.ts"
import type { Chat } from "./types.ts"

function chat(id: string, createdAt: string): Chat {
  return {
    id,
    createdAt: new Date(createdAt),
    systemPrompt: "test",
    messages: [],
  }
}

function withTempState(fn: (stateHome: string) => void) {
  const oldStateHome = process.env.XDG_STATE_HOME
  const stateHome = mkdtempSync("/tmp/llm-storage-test-")
  process.env.XDG_STATE_HOME = stateHome
  try {
    fn(stateHome)
  } finally {
    if (oldStateHome === undefined) {
      delete process.env.XDG_STATE_HOME
    } else {
      process.env.XDG_STATE_HOME = oldStateHome
    }
    rmSync(stateHome, { recursive: true })
  }
}

Deno.test("History.save stores chats independently and tracks current", () => {
  withTempState(() => {
    History.save(chat("one", "2026-01-01T00:00:00Z"), { current: true })
    History.save(chat("two", "2026-01-02T00:00:00Z"), { current: true })

    assertEquals(History.list().map((c) => c.id), ["one", "two"])
    assertEquals(History.current()?.id, "two")
  })
})

Deno.test("History preserves multiple images and loads legacy single-image messages", () => {
  withTempState((stateHome) => {
    const images = ["data:image/png;base64,AQID", "https://example.com/second.jpg"]
    const saved = chat("images", "2026-01-01T00:00:00Z")
    saved.messages.push({
      role: "user",
      content: "Compare these",
      createdAt: saved.createdAt,
      image_urls: images,
    })
    History.save(saved, { current: true })
    assertEquals(History.current()?.messages[0], saved.messages[0])

    const path = join(stateHome, "llm-cli", "chats", "images.json")
    const legacy = JSON.parse(readFileSync(path, "utf8"))
    delete legacy.messages[0].image_urls
    legacy.messages[0].image_url = images[0]
    writeFileSync(path, JSON.stringify(legacy))

    const loaded = History.current()!
    assertEquals(loaded.messages[0], {
      role: "user",
      content: "Compare these",
      createdAt: saved.createdAt,
      image_urls: [images[0]],
    })
    assertEquals(JSON.parse(readFileSync(path, "utf8")).messages[0].image_url, images[0])
    History.save(loaded)
    const persisted = JSON.parse(readFileSync(path, "utf8")).messages[0]
    assertEquals(persisted.image_urls, [images[0]])
    assertEquals("image_url" in persisted, false)
  })
})

Deno.test("History.delete removes selected chat without rewriting others", () => {
  withTempState(() => {
    History.save(chat("one", "2026-01-01T00:00:00Z"), { current: true })
    History.save(chat("two", "2026-01-02T00:00:00Z"), { current: true })

    History.delete(["one"])

    assertEquals(History.list().map((c) => c.id), ["two"])
    assertEquals(History.current()?.id, "two")
  })
})

Deno.test("History.clear removes every chat", () => {
  withTempState(() => {
    History.save(chat("one", "2026-01-01T00:00:00Z"), { current: true })

    History.clear()

    assertEquals(History.list(), [])
  })
})

Deno.test("History.save rejects stale same-chat writes", () => {
  withTempState(() => {
    History.save(chat("one", "2026-01-01T00:00:00Z"), { current: true })
    const first = History.current()!
    const second = History.current()!

    first.summary = "first"
    History.save(first)

    second.summary = "second"
    assertThrows(
      () => History.save(second),
      Error,
      "changed concurrently",
    )
    assertEquals(History.current()?.summary, "first")
  })
})

Deno.test("imageFilename uses local timestamp and prompt slug", () => {
  const date = new Date(2026, 8, 23, 14, 5, 9)
  assertEquals(
    imageFilename("A cat, in a hat!", date, "png"),
    "20260923-140509-a-cat-in-a-hat.png",
  )
  assertEquals(imageFilename("", date, "png", 1), "20260923-140509-2.png")
  assertEquals(
    imageFilename("x".repeat(50) + " tail", date, "png"),
    `20260923-140509-${"x".repeat(40)}.png`,
  )
})

Deno.test("saveImage keeps an existing file with the same name", () => {
  withTempState((stateHome) => {
    const date = new Date(2026, 8, 23, 14, 5, 9)
    const dir = join(stateHome, "llm-cli", "images")
    const existing = join(dir, imageFilename("same prompt", date, "png"))
    mkdirSync(dir, { recursive: true })
    writeFileSync(existing, new Uint8Array([1]))
    const saved = saveImage(new Uint8Array([2]), "same prompt", "png", 0, date)
    assertEquals([...readFileSync(existing)], [1])
    assertEquals([...readFileSync(saved)], [2])
  })
})
