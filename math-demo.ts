import { renderMd } from "./display.ts"

await renderMd(
  await Deno.readTextFile(new URL("./fixtures/terminal-math.md", import.meta.url)),
)
