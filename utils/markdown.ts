type JSONValue =
  | { [key: string]: JSONValue }
  | JSONValue[]
  | string
  | number
  | boolean
  | null

export function codeBlock(contents: string, lang = "") {
  return `\`\`\`${lang}
${contents}
\`\`\`
`
}

export const jsonBlock = (obj: JSONValue) => codeBlock(JSON.stringify(obj, null, 2), "json")
