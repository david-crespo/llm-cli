import { assertEquals } from "@std/assert"
import { History } from "./storage.ts"

Deno.test({
  name: "History.clear writes empty file tombstone",
  fn() {
    const oldStateHome = Deno.env.get("XDG_STATE_HOME")
    const stateHome = Deno.makeTempDirSync({ dir: "/tmp" })
    Deno.env.set("XDG_STATE_HOME", stateHome)
    try {
      History.write([{
        id: crypto.randomUUID(),
        createdAt: new Date("2026-01-02T03:04:05Z"),
        systemPrompt: "test",
        messages: [],
      }])

      History.clear()

      assertEquals(History.read(), [])
    } finally {
      if (oldStateHome === undefined) {
        Deno.env.delete("XDG_STATE_HOME")
      } else {
        Deno.env.set("XDG_STATE_HOME", oldStateHome)
      }
      Deno.removeSync(stateHome, { recursive: true })
    }
  },
})
