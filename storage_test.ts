import { assertEquals, assertThrows } from "@std/assert"
import { join } from "@std/path"
import { History } from "./storage.ts"
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
  const oldStateHome = Deno.env.get("XDG_STATE_HOME")
  const stateHome = Deno.makeTempDirSync({ dir: "/tmp" })
  Deno.env.set("XDG_STATE_HOME", stateHome)
  try {
    fn(stateHome)
  } finally {
    if (oldStateHome === undefined) {
      Deno.env.delete("XDG_STATE_HOME")
    } else {
      Deno.env.set("XDG_STATE_HOME", oldStateHome)
    }
    Deno.removeSync(stateHome, { recursive: true })
  }
}

Deno.test("History.save stores chats independently and tracks current", () => {
  withTempState(() => {
    History.save(chat("one", "2026-01-01T00:00:00Z"), { current: true })
    History.save(chat("two", "2026-01-02T00:00:00Z"), { current: true })

    assertEquals(History.read().map((c) => c.id), ["one", "two"])
    assertEquals(History.current()?.id, "two")
  })
})

Deno.test("History.delete removes selected chat without rewriting others", () => {
  withTempState(() => {
    History.save(chat("one", "2026-01-01T00:00:00Z"), { current: true })
    History.save(chat("two", "2026-01-02T00:00:00Z"), { current: true })

    History.delete(["one"])

    assertEquals(History.read().map((c) => c.id), ["two"])
    assertEquals(History.current()?.id, "two")
  })
})

Deno.test("History.clear leaves empty per-chat store tombstone", () => {
  withTempState(() => {
    History.save(chat("one", "2026-01-01T00:00:00Z"), { current: true })

    History.clear()

    assertEquals(History.read(), [])
  })
})

Deno.test("History.write preserves legacy history recency order", () => {
  withTempState((stateHome) => {
    const root = join(stateHome, "llm-cli")
    History.write([
      chat("one", "2026-01-02T00:00:00Z"),
      chat("two", "2026-01-01T00:00:00Z"),
    ])

    assertEquals(History.read().map((c) => c.id), ["one", "two"])
    assertEquals(History.current()?.id, "two")
    assertEquals(Deno.statSync(join(root, "chats", "one.json")).isFile, true)
    assertEquals(Deno.statSync(join(root, "chats", "two.json")).isFile, true)
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
