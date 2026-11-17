import { type Type, type as arkType } from "arktype"
import JSON5 from "json5"

/** Parse a `--output-schema` argument with arktype. */
export function parseType(input: string): Type {
  // Parse object and tuple schemas as JSON5 (single quotes, unquoted keys,
  // trailing commas) and pass everything else to arktype's string DSL. Trying
  // JSON5 first tolerates leading whitespace and comments; this is safe because
  // arktype's string DSL (`boolean`, `'a'|'b'`, `number > 0`) is never valid JSON5.
  let parsed: unknown
  try {
    parsed = JSON5.parse(input)
  } catch (e) {
    // Report the JSON5 syntax error for malformed `{...}` or `[...]` input
    // rather than falling through to arktype.
    if (/^\s*[{[]/.test(input)) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`Failed to parse output schema as JSON5: ${msg}`)
    }
    return arkType.raw(input)
  }
  return parsed !== null && typeof parsed === "object"
    ? arkType.raw(parsed)
    : arkType.raw(input)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Add `additionalProperties: false` to every object type in a JSON schema.
 * Required by Anthropic (always) and OpenAI (in strict mode). arktype's
 * `toJsonSchema()` doesn't emit it, so we add it recursively.
 */
function closeObjects(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object") return schema
  if (Array.isArray(schema)) return schema.map(closeObjects)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema)) {
    if (k !== "$schema") out[k] = closeObjects(v)
  }
  if (out.type === "object" && out.additionalProperties === undefined) {
    out.additionalProperties = false
  }
  return out
}

/** OpenAI strict mode requires every object property to be in `required`. */
function forceAllRequired(s: unknown): unknown {
  if (s === null || typeof s !== "object") return s
  if (Array.isArray(s)) return s.map(forceAllRequired)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s)) out[k] = forceAllRequired(v)
  if (out.type === "object" && isRecord(out.properties)) {
    out.required = Object.keys(out.properties)
  }
  return out
}

/**
 * Build a JSON schema suitable for a provider's structured-output API.
 *
 * `wrapPrimitives`: wrap non-object roots in `{ value: <schema> }`. Required
 * by OpenAI strict mode, which only accepts object roots.
 * `allRequired`: mark every object property required. Also required by
 * OpenAI strict mode.
 *
 * Returns `wrapped: true` when wrapping was applied, so callers can unwrap
 * the response.
 */
export function prepareSchema(
  t: Type,
  opts: { wrapPrimitives?: boolean; allRequired?: boolean } = {},
): { schema: Record<string, unknown>; wrapped: boolean } {
  let schema = closeObjects(t.toJsonSchema()) as Record<string, unknown>
  const wrapped = !!opts.wrapPrimitives && schema.type !== "object"
  if (wrapped) {
    schema = {
      type: "object",
      properties: { value: schema },
      additionalProperties: false,
      required: ["value"],
    }
  }
  if (opts.allRequired) schema = forceAllRequired(schema) as Record<string, unknown>
  return { schema, wrapped }
}

/**
 * Post-process structured-output content for shell use:
 * - if wrapped, extract `.value`
 * - if the result is a bare string, drop the JSON quotes
 * - otherwise leave as-is (JSON objects/arrays/numbers/booleans already
 *   serialize to shell-friendly forms)
 */
export function postprocessSchemaContent(content: string, wrapped: boolean): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return content
  }
  if (wrapped && isRecord(parsed) && "value" in parsed) {
    parsed = parsed.value
  }
  if (typeof parsed === "string") return parsed
  // re-stringify only if we unwrapped; otherwise preserve provider's formatting
  return wrapped ? JSON.stringify(parsed) : content
}
