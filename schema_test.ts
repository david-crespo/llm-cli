import { assertEquals, assertThrows } from "@std/assert"
import { parseType, postprocessSchemaContent, prepareSchema } from "./schema.ts"

function schema(input: string): Record<string, unknown> {
  const { $schema: _, ...rest } = parseType(input).toJsonSchema() as Record<
    string,
    unknown
  >
  return rest
}

Deno.test("parseType - string DSL schemas", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["boolean", { type: "boolean" }],
    ["string", { type: "string" }],
    ["number", { type: "number" }],
    ["'yes' | 'no'", { enum: ["no", "yes"] }],
    ["string[]", { type: "array", items: { type: "string" } }],
  ]

  for (const [input, expected] of cases) {
    assertEquals(schema(input), expected)
  }
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

Deno.test("parseType - parse errors", () => {
  const cases = [
    ["blargh", "'blargh' is unresolvable"],
    ["'yes' |", "Token '|' requires a right operand"],
    ["{ x: 'nonsense' }", "'nonsense' is unresolvable"],
    ["{ x: ", "Failed to parse output schema as JSON5"],
    ["{ x: 1 + 2 }", "Failed to parse output schema as JSON5"],
    ["{ x: 'number' } foo", "Failed to parse output schema as JSON5"],
  ] as const

  for (const [input, expectedError] of cases) {
    assertThrows(() => parseType(input), Error, expectedError)
  }
})

// Red-team: things `new Function` / eval would have accepted must now be
// rejected by JSON5. All of these should fail before arktype ever sees them.

Deno.test("red-team - object literal expressions are rejected", () => {
  const cases = [
    "{ x: Date.now() }",
    "{ x: Deno }",
    "{ x: (() => 'string')() }",
    "{ x: `string` }",
    "{ x: /foo/ }",
    "{ x: new Date() }",
    "{ ...{ x: 'string' } }",
    "{ x: 'foo'.repeat(3) }",
    "{ x: (0, 'string') }",
  ]

  for (const input of cases) {
    assertThrows(
      () => parseType(input),
      Error,
      "Failed to parse output schema as JSON5",
    )
  }
})

Deno.test("prepareSchema - closes nested objects", () => {
  const { schema, wrapped } = prepareSchema(
    parseType("{ user: { name: 'string', age: 'number' }, tags: 'string[]' }"),
  )
  assertEquals(wrapped, false)
  assertEquals(schema, {
    type: "object",
    properties: {
      user: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["age", "name"],
        additionalProperties: false,
      },
      tags: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["tags", "user"],
    additionalProperties: false,
  })
})

Deno.test("prepareSchema - wraps primitive roots", () => {
  const { schema, wrapped } = prepareSchema(parseType("'yes' | 'no'"), {
    wrapPrimitives: true,
    allRequired: true,
  })
  assertEquals(wrapped, true)
  assertEquals(schema, {
    type: "object",
    properties: {
      value: { enum: ["no", "yes"] },
    },
    additionalProperties: false,
    required: ["value"],
  })
})

Deno.test("prepareSchema - can force all properties required", () => {
  const { schema } = prepareSchema(
    parseType("{ urgent: 'boolean', 'reason?': 'string' }"),
    { allRequired: true },
  )
  assertEquals(schema.required, ["urgent", "reason"])
})

Deno.test("prepareSchema - normalizes objects inside arrays", () => {
  const { schema } = prepareSchema(
    parseType("{ users: [{ name: 'string', 'age?': 'number' }, '[]'] }"),
    { allRequired: true },
  )
  assertEquals(schema, {
    type: "object",
    properties: {
      users: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "number" },
          },
          required: ["name", "age"],
          additionalProperties: false,
        },
      },
    },
    required: ["users"],
    additionalProperties: false,
  })
})

Deno.test("postprocessSchemaContent - unwraps primitive wrapper", () => {
  assertEquals(postprocessSchemaContent(`{"value":"hello"}`, true), "hello")
  assertEquals(postprocessSchemaContent(`{"value":3}`, true), "3")
  assertEquals(postprocessSchemaContent(`{"value":["a","b"]}`, true), `["a","b"]`)
})

Deno.test("postprocessSchemaContent - removes bare string quotes", () => {
  assertEquals(postprocessSchemaContent(`"hello"`, false), "hello")
})

Deno.test("postprocessSchemaContent - preserves non-wrapped JSON formatting", () => {
  const content = `{
  "answer": "yes"
}`
  assertEquals(postprocessSchemaContent(content, false), content)
})

Deno.test("postprocessSchemaContent - preserves non-wrapped value property", () => {
  const content = `{"value":"hello"}`
  assertEquals(postprocessSchemaContent(content, false), content)
})

Deno.test("postprocessSchemaContent - preserves malformed JSON", () => {
  assertEquals(postprocessSchemaContent("not json", true), "not json")
})
