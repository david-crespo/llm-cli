import { assertEquals, assertThrows } from "@std/assert"
import { parseType } from "./schema.ts"

function schema(input: string) {
  const { $schema: _, ...rest } = parseType(input).toJsonSchema() as Record<
    string,
    unknown
  >
  return rest
}

Deno.test("parseType - boolean primitive", () => {
  assertEquals(schema("boolean"), { type: "boolean" })
})

Deno.test("parseType - string primitive", () => {
  assertEquals(schema("string"), { type: "string" })
})

Deno.test("parseType - number primitive", () => {
  assertEquals(schema("number"), { type: "number" })
})

Deno.test("parseType - string literal union", () => {
  assertEquals(schema("'yes' | 'no'"), { enum: ["no", "yes"] })
})

Deno.test("parseType - string array", () => {
  assertEquals(schema("string[]"), {
    type: "array",
    items: { type: "string" },
  })
})

Deno.test("parseType - object with optional field", () => {
  assertEquals(schema("{ urgent: 'boolean', 'reason?': 'string' }"), {
    type: "object",
    properties: {
      urgent: { type: "boolean" },
      reason: { type: "string" },
    },
    required: ["urgent"],
  })
})

Deno.test("parseType - union inside object (nested-quote form)", () => {
  assertEquals(schema(`{ answer: "'yes'|'no'" }`), {
    type: "object",
    properties: {
      answer: { enum: ["no", "yes"] },
    },
    required: ["answer"],
  })
})

Deno.test("parseType - nested object", () => {
  assertEquals(
    schema("{ user: { name: 'string', age: 'number' } }"),
    {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "number" },
          },
          required: ["age", "name"],
        },
      },
      required: ["user"],
    },
  )
})

Deno.test("parseType - leading/trailing whitespace is fine", () => {
  assertEquals(schema("  boolean  "), { type: "boolean" })
  assertEquals((schema("  { x: 'number' }") as { type: string }).type, "object")
})

Deno.test("parseType - refinement (number > 0)", () => {
  const s = schema("number > 0") as { type: string; exclusiveMinimum: number }
  assertEquals(s.type, "number")
  assertEquals(s.exclusiveMinimum, 0)
})

Deno.test("parseType - unresolvable string", () => {
  assertThrows(
    () => parseType("blargh"),
    Error,
    "'blargh' is unresolvable",
  )
})

Deno.test("parseType - dangling union operator", () => {
  assertThrows(
    () => parseType("'yes' |"),
    Error,
    "Token '|' requires a right operand",
  )
})

Deno.test("parseType - unresolvable value inside object", () => {
  assertThrows(
    () => parseType("{ x: 'nonsense' }"),
    Error,
    "'nonsense' is unresolvable",
  )
})

Deno.test("parseType - truncated object literal", () => {
  assertThrows(
    () => parseType("{ x: "),
    Error,
    "Failed to parse output schema as JSON5",
  )
})

Deno.test("parseType - expressions in object literals are rejected", () => {
  // JSON5 rejects `1 + 2`, so arbitrary JS can't sneak in
  assertThrows(
    () => parseType("{ x: 1 + 2 }"),
    Error,
    "Failed to parse output schema as JSON5",
  )
})

Deno.test("parseType - trailing garbage after object literal", () => {
  assertThrows(
    () => parseType("{ x: 'number' } foo"),
    Error,
    "Failed to parse output schema as JSON5",
  )
})

// Red-team: things `new Function` / eval would have accepted must now be
// rejected by JSON5. All of these should fail before arktype ever sees them.

Deno.test("red-team - function call in value is rejected", () => {
  assertThrows(
    () => parseType("{ x: Date.now() }"),
    Error,
    "Failed to parse output schema as JSON5",
  )
})

Deno.test("red-team - bare identifier reference is rejected", () => {
  assertThrows(
    () => parseType("{ x: Deno }"),
    Error,
    "Failed to parse output schema as JSON5",
  )
})

Deno.test("red-team - IIFE is rejected", () => {
  assertThrows(
    () => parseType("{ x: (() => 'string')() }"),
    Error,
    "Failed to parse output schema as JSON5",
  )
})

Deno.test("red-team - template literal is rejected", () => {
  assertThrows(
    () => parseType("{ x: `string` }"),
    Error,
    "Failed to parse output schema as JSON5",
  )
})

Deno.test("red-team - regex literal is rejected", () => {
  assertThrows(
    () => parseType("{ x: /foo/ }"),
    Error,
    "Failed to parse output schema as JSON5",
  )
})

Deno.test("red-team - new expression is rejected", () => {
  assertThrows(
    () => parseType("{ x: new Date() }"),
    Error,
    "Failed to parse output schema as JSON5",
  )
})

Deno.test("red-team - spread is rejected", () => {
  assertThrows(
    () => parseType("{ ...{ x: 'string' } }"),
    Error,
    "Failed to parse output schema as JSON5",
  )
})

Deno.test("red-team - method call on string is rejected", () => {
  assertThrows(
    () => parseType("{ x: 'foo'.repeat(3) }"),
    Error,
    "Failed to parse output schema as JSON5",
  )
})

Deno.test("red-team - sequence operator is rejected", () => {
  // with eval: (sideEffect(), 'string') returns 'string' — fully exploitable
  assertThrows(
    () => parseType("{ x: (0, 'string') }"),
    Error,
    "Failed to parse output schema as JSON5",
  )
})
