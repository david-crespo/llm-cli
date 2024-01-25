#! /usr/bin/env -S deno run --allow-run 

async function glow(s: string) {
  const echo = new Deno.Command("echo", { args: [s], stdout: "piped" })
  const render = new Deno.Command("glow", { stdin: "piped", stdout: "piped" })

  echo.outputSync()
  const { stdout } = render.spawn()
  const chunks = []
  for await (const chunk of stdout) {
    chunks.push(chunk)
  }
  return chunks
}

const md = "# hello\n\nsome paragraphtext\n\n|abc|def|\n|---|---|\n|key|value|"
console.log(await glow(md))
