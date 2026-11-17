import { renderMd } from "../src/display.ts"
import { readFile } from "node:fs/promises"

await renderMd(
  await readFile(new URL("../test/fixtures/terminal-math.md", import.meta.url), "utf8"),
)
