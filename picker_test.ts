import { assert, assertEquals } from "@std/assert"
import stringWidth from "string-width"
import { formatPickerOptions, keyAction } from "./picker.ts"

Deno.test("picker options stay single-line and preserve their row mapping", () => {
  const options = formatPickerOptions([
    {
      summary: "A summary with an embedded newline\nand a long second thought",
      model: "gpt-5.6-sol",
      meta: "8/28 12:44 (2)",
    },
    {
      summary: "Short summary",
      model: "opus-5",
      meta: "8/27 09:24 (4)",
    },
  ], 60)

  assertEquals(options.length, 2)
  assert(options.every((option) => !option.includes("\n")))
  assert(options.every((option) => stringWidth(option) <= 58))
  assert(options[0].includes("…"))
  assert(options[0].endsWith("8/28 12:44 (2)"))
  assert(options[1].endsWith("8/27 09:24 (4)"))
})

Deno.test("picker options retain full summaries when they fit", () => {
  const [option] = formatPickerOptions([{
    summary: "  Emoji 🦀 summary  ",
    model: "opus-5",
    meta: "8/28 12:44 (2)",
  }], 80)

  assert(option.startsWith("Emoji 🦀 summary"))
  assert(!option.includes("…"))
})

Deno.test("picker keys map to actions and leave navigation alone", () => {
  assertEquals(keyAction({ name: "r" }), "resume")
  assertEquals(keyAction({ name: "s" }), "show")
  assertEquals(keyAction({ name: "s", shift: true }), "showAll")
  assertEquals(keyAction({ name: "f" }), "fork")
  assertEquals(keyAction({ name: "d" }), "delete")
  assertEquals(keyAction({ name: "q" }), "quit")
  assertEquals(keyAction({ name: "escape" }), "quit")
  assertEquals(keyAction({ name: "j" }), undefined)
  assertEquals(keyAction({ name: "return" }), undefined)
  assertEquals(keyAction({ name: "d", ctrl: true }), undefined)
  assertEquals(keyAction({ name: "c", ctrl: true }), undefined)
})
