import { type JSONValue } from "https://deno.land/std@0.184.0/jsonc/mod.ts"

export function codeBlock(contents: string, lang = "") {
  return `\`\`\`${lang}
${contents}
\`\`\`
`
}

export const jsonBlock = (obj: JSONValue) => codeBlock(JSON.stringify(obj, null, 2), "json")

type Row = string[]

const makeRow = (row: Row) => "| " + row.join(" | ") + " |"

export function mdTable(header: Row, rows: Row[]) {
  if (!rows.every((row) => row.length === header.length)) {
    throw Error("Error: header and rows must all have the same cell count")
  }

  const divider = makeRow(Array(header.length).fill("---"))
  return [makeRow(header), divider, ...rows.map(makeRow)]
    .join("\n")
}
