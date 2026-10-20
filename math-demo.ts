import { renderMd } from "./display.ts"
import { readFile } from "node:fs/promises"

await renderMd(
  await readFile(new URL("./fixtures/terminal-math.md", import.meta.url), "utf8"),
)
