import { type Type, type as arkType } from "arktype"
import JSON5 from "json5"

/**
 * Parse a `--output-schema` argument with arktype.
 *
 * Inputs starting with `{` or `[` are parsed as JSON5 (permits single quotes,
 * unquoted keys, trailing commas) and passed to arktype as an object/tuple
 * definition. Everything else is passed directly to arktype's string DSL,
 * which handles primitives, unions, arrays (`string[]`), refinements
 * (`number > 0`), etc.
 *
 * JSON5 is used instead of `eval` so malformed input produces a readable
 * parse error and no arbitrary JS can run.
 */
// arktype's `type` is heavily overloaded on string literals. For our dynamic
// input we route through a loosely-typed alias to avoid deep instantiation.
// deno-lint-ignore no-explicit-any
const ark = arkType as unknown as (def: any) => Type

export function parseType(input: string): Type {
  // The naive order here would be "if input starts with `{` or `[`, parse
  // as JSON5, else pass to arktype's string DSL." We invert that: try JSON5
  // first, and only commit to it if the result is an object/array. This is more
  // robust to leading whitespace, comments, or any other JSON5-tolerated noise
  // without a hand-rolled sniff test. It's safe because arktype's string DSL
  // (`boolean`, `'a'|'b'`, `number > 0`) is never valid JSON5. We still sniff
  // for `{`/`[` on the error path so malformed object input surfaces the JSON5
  // error rather than a less helpful error from arktype.
  let parsed: unknown
  try {
    parsed = JSON5.parse(input)
  } catch (e) {
    // JSON5 failed. If the input clearly *meant* to be an object/tuple,
    // surface the JSON5 error. Otherwise fall through to arktype's string DSL.
    if (/^\s*[{[]/.test(input)) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`Failed to parse output schema as JSON5: ${msg}`)
    }
    return ark(input)
  }
  return parsed !== null && typeof parsed === "object" ? ark(parsed) : ark(input)
}
