import assert from "node:assert/strict"
import { test } from "node:test"
import { errorIncluding } from "./testing.ts"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
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
  const stateHome = mkdtempSync(join(tmpdir(), "llm-storage-test-"))
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

test("History.save stores chats independently and tracks current", () => {
  withTempState(() => {
    History.save(chat("one", "2026-01-01T00:00:00Z"), { current: true })
    History.save(chat("two", "2026-01-02T00:00:00Z"), { current: true })

    assert.deepEqual(
      History.list().map((c) => c.id),
      ["one", "two"],
    )
    assert.deepEqual(History.current()?.id, "two")
  })
})

test("History preserves multiple images and loads legacy single-image messages", () => {
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
    assert.deepEqual(History.current()?.messages[0], saved.messages[0])

    const path = join(stateHome, "llm-cli", "chats", "images.json")
    const legacy = JSON.parse(readFileSync(path, "utf8"))
    delete legacy.messages[0].image_urls
    legacy.messages[0].image_url = images[0]
    writeFileSync(path, JSON.stringify(legacy))

    const loaded = History.current()!
    assert.deepEqual(loaded.messages[0], {
      role: "user",
      content: "Compare these",
      createdAt: saved.createdAt,
      image_urls: [images[0]],
    })
    assert.deepEqual(
      JSON.parse(readFileSync(path, "utf8")).messages[0].image_url,
      images[0],
    )
    History.save(loaded)
    const persisted = JSON.parse(readFileSync(path, "utf8")).messages[0]
    assert.deepEqual(persisted.image_urls, [images[0]])
    assert.deepEqual("image_url" in persisted, false)
  })
})

test("History.delete removes selected chat without rewriting others", () => {
  withTempState(() => {
    History.save(chat("one", "2026-01-01T00:00:00Z"), { current: true })
    History.save(chat("two", "2026-01-02T00:00:00Z"), { current: true })

    History.delete(["one"])

    assert.deepEqual(
      History.list().map((c) => c.id),
      ["two"],
    )
    assert.deepEqual(History.current()?.id, "two")
  })
})

test("History.delete moves current to the most recently active chat that remains", () => {
  withTempState(() => {
    History.save(chat("one", "2026-01-01T00:00:00Z"))
    History.save(chat("two", "2026-01-02T00:00:00Z"), { current: true })

    History.delete(["two"])
    assert.deepEqual(History.current()?.id, "one")

    History.delete(["one"])
    assert.deepEqual(History.current(), undefined)
  })
})

test("History.save prunes the least recently active chats beyond 30", () => {
  withTempState(() => {
    const ids = Array.from({ length: 31 }, (_, i) => `c${String(i).padStart(2, "0")}`)
    // Created a day apart, in order, so c00 is the oldest
    const created = (i: number) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString()
    for (const [i, id] of ids.slice(0, 30).entries()) History.save(chat(id, created(i)))
    History.touch("c00")
    History.save(chat("c30", created(30)))

    const listed = History.list().map((c) => c.id)
    assert.deepEqual(listed, [...ids.slice(2), "c00"])
    assert.deepEqual(History.current()?.id, "c00")
  })
})

test("History revives a background response's start time and finds the latest one", () => {
  withTempState(() => {
    const background = {
      id: "resp_1",
      status: "queued" as const,
      startedAt: new Date("2026-01-03T00:00:00Z"),
      provider: "openai" as const,
      modelId: "gpt",
    }
    History.save({ ...chat("bg", "2026-01-01T00:00:00Z"), background })
    History.save(chat("plain", "2026-01-02T00:00:00Z"))

    const found = History.findLatestBackground()
    assert.deepEqual(found?.id, "bg")
    assert(found?.background?.startedAt instanceof Date, "startedAt should load as a Date")
    assert.deepEqual(found?.background, background)
  })
})

test("History.clear removes every chat", () => {
  withTempState(() => {
    History.save(chat("one", "2026-01-01T00:00:00Z"), { current: true })

    History.clear()

    assert.deepEqual(History.list(), [])
  })
})

test("History.save rejects stale same-chat writes", () => {
  withTempState(() => {
    History.save(chat("one", "2026-01-01T00:00:00Z"), { current: true })
    const first = History.current()!
    const second = History.current()!

    first.summary = "first"
    History.save(first)

    second.summary = "second"
    assert.throws(() => History.save(second), errorIncluding(Error, "changed concurrently"))
    assert.deepEqual(History.current()?.summary, "first")
  })
})

test("imageFilename uses local timestamp and prompt slug", () => {
  const date = new Date(2026, 8, 23, 14, 5, 9)
  assert.deepEqual(
    imageFilename("A cat, in a hat!", date, "png"),
    "20260923-140509-a-cat-in-a-hat.png",
  )
  assert.deepEqual(imageFilename("", date, "png", 1), "20260923-140509-2.png")
  assert.deepEqual(
    imageFilename("x".repeat(50) + " tail", date, "png"),
    `20260923-140509-${"x".repeat(40)}.png`,
  )
})

test("saveImage keeps an existing file with the same name", () => {
  withTempState((stateHome) => {
    const date = new Date(2026, 8, 23, 14, 5, 9)
    const dir = join(stateHome, "llm-cli", "images")
    const existing = join(dir, imageFilename("same prompt", date, "png"))
    mkdirSync(dir, { recursive: true })
    writeFileSync(existing, new Uint8Array([1]))
    const saved = saveImage(new Uint8Array([2]), "same prompt", "png", 0, date)
    assert.deepEqual([...readFileSync(existing)], [1])
    assert.deepEqual([...readFileSync(saved)], [2])
  })
})
