import { readAll } from "https://deno.land/std@0.184.0/streams/read_all.ts"

/** Read from `Deno.args[i]`, but `-` makes it readAll from stdin */
export async function getInput(i = 0) {
  if (Deno.args[i] === "-") {
    return new TextDecoder().decode(await readAll(Deno.stdin)).trim()
  }
  return Deno.args[0]
}
