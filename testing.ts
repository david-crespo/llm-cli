import assert from "node:assert/strict"

/**
 * An `assert.throws`/`assert.rejects` validator for an instance of `type` whose
 * message includes `text`. Node's own third argument is the failure message,
 * not a substring to match.
 */
export function errorIncluding(type: abstract new (...args: never) => Error, text: string) {
  return (e: unknown) => {
    assert(e instanceof type, `Expected ${type.name}, got ${e}`)
    assert(e.message.includes(text), `Expected "${e.message}" to include "${text}"`)
    return true
  }
}

export function assertAlmostEqual(actual: number, expected: number, tolerance = 1e-7) {
  assert(
    Math.abs(actual - expected) < tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  )
}
