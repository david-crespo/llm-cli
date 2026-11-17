import assert from "node:assert/strict"
import { test } from "node:test"
import { errorIncluding } from "./testing.ts"
import { parseType, postprocessSchemaContent, prepareSchema } from "./schema.ts"

function schema(input: string): Record<string, unknown> {
  const { $schema: _, ...rest } = parseType(input).toJsonSchema() as Record<string, unknown>
  return rest
}

test("parseType - string DSL schema", () => {
  assert.deepEqual(schema("string[]"), { type: "array", items: { type: "string" } })
})

test("parseType - object with optional field", () => {
  assert.deepEqual(schema("{ urgent: 'boolean', 'reason?': 'string' }"), {
    type: "object",
    properties: {
      urgent: { type: "boolean" },
      reason: { type: "string" },
    },
    required: ["urgent"],
  })
})

test("parseType - union inside object (nested-quote form)", () => {
  assert.deepEqual(schema(`{ answer: "'yes'|'no'" }`), {
    type: "object",
    properties: {
      answer: { enum: ["no", "yes"] },
    },
    required: ["answer"],
  })
})

test("parseType - leading/trailing whitespace is fine", () => {
  assert.deepEqual(schema("  boolean  "), { type: "boolean" })
  assert.deepEqual((schema("  { x: 'number' }") as { type: string }).type, "object")
})

test("parseType - parse errors", () => {
  // These messages come from arktype, so only check that parsing fails.
  for (const input of ["blargh", "'yes' |", "{ x: 'nonsense' }"]) {
    assert.throws(() => parseType(input))
  }
  for (const input of [
    "{ x: ",
    "{ x: 1 + 2 }",
    "{ x: 'number' } foo",
    "{ x: Date.now() }",
  ]) {
    assert.throws(
      () => parseType(input),
      errorIncluding(Error, "Failed to parse output schema as JSON5"),
    )
  }
})

test("prepareSchema - closes nested objects", () => {
  const { schema, wrapped } = prepareSchema(
    parseType("{ user: { name: 'string', age: 'number' }, tags: 'string[]' }"),
  )
  assert.deepEqual(wrapped, false)
  assert.deepEqual(schema, {
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

test("prepareSchema - wraps primitive roots", () => {
  const { schema, wrapped } = prepareSchema(parseType("'yes' | 'no'"), {
    wrapPrimitives: true,
    allRequired: true,
  })
  assert.deepEqual(wrapped, true)
  assert.deepEqual(schema, {
    type: "object",
    properties: {
      value: { enum: ["no", "yes"] },
    },
    additionalProperties: false,
    required: ["value"],
  })
})

test("prepareSchema - can force all properties required", () => {
  const { schema } = prepareSchema(
    parseType("{ urgent: 'boolean', 'reason?': 'string' }"),
    { allRequired: true },
  )
  assert.deepEqual(schema.required, ["urgent", "reason"])
})

test("prepareSchema - normalizes objects inside arrays", () => {
  const { schema } = prepareSchema(
    parseType("{ users: [{ name: 'string', 'age?': 'number' }, '[]'] }"),
    { allRequired: true },
  )
  assert.deepEqual(schema, {
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

test("postprocessSchemaContent - unwraps primitive wrapper", () => {
  assert.deepEqual(postprocessSchemaContent(`{"value":"hello"}`, true), "hello")
  assert.deepEqual(postprocessSchemaContent(`{"value":3}`, true), "3")
  assert.deepEqual(postprocessSchemaContent(`{"value":["a","b"]}`, true), `["a","b"]`)
})

test("postprocessSchemaContent - removes bare string quotes", () => {
  assert.deepEqual(postprocessSchemaContent(`"hello"`, false), "hello")
})

test("postprocessSchemaContent - preserves non-wrapped JSON formatting", () => {
  const content = `{
  "answer": "yes"
}`
  assert.deepEqual(postprocessSchemaContent(content, false), content)
})

test("postprocessSchemaContent - preserves non-wrapped value property", () => {
  const content = `{"value":"hello"}`
  assert.deepEqual(postprocessSchemaContent(content, false), content)
})

test("postprocessSchemaContent - preserves malformed JSON", () => {
  assert.deepEqual(postprocessSchemaContent("not json", true), "not json")
})
