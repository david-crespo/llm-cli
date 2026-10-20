import assert from "node:assert/strict"
import stringWidth from "string-width"
import { alignColumns, formatPickerOptions, keyAction } from "./picker.ts"

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

  assert.deepEqual(options.length, 2)
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
  assert.deepEqual(keyAction({ name: "r" }), "resume")
  assert.deepEqual(keyAction({ name: "s" }), "show")
  assert.deepEqual(keyAction({ name: "s", shift: true }), "showAll")
  assert.deepEqual(keyAction({ name: "f" }), "fork")
  assert.deepEqual(keyAction({ name: "d" }), "delete")
  assert.deepEqual(keyAction({ name: "q" }), "quit")
  assert.deepEqual(keyAction({ name: "escape" }), "quit")
  assert.deepEqual(keyAction({ name: "j" }), undefined)
  assert.deepEqual(keyAction({ name: "return" }), undefined)
  assert.deepEqual(keyAction({ name: "d", ctrl: true }), undefined)
  assert.deepEqual(keyAction({ name: "c", ctrl: true }), undefined)
})

Deno.test("alignColumns pads every column but the last to its widest cell", () => {
  assert.deepEqual(
    alignColumns([
      ["1", "user", "hello"],
      ["10", "opus-5 🦀", "hi"],
    ]),
    [
      "1    user        hello",
      "10   opus-5 🦀   hi",
    ],
  )
  assert.deepEqual(alignColumns([]), [])
})
