import { ValidationError } from "./errors.ts"
import { range } from "./utils.ts"

const parsePart = (part: string, msgCount: number): number[] => {
  if (part === "even" || part === "odd") {
    const start = part === "even" ? 2 : 1
    return range(start, msgCount + 1).filter((n) => n % 2 === (part === "even" ? 0 : 1))
  }

  if (/^\d+-\d+$/.test(part)) {
    const [startStr, endStr] = part.split("-")
    const start = Number(startStr)
    const end = Number(endStr)
    if (start > end) {
      throw new ValidationError(`Invalid range: start > end in "${part}"`)
    }
    return range(start, end + 1)
  }

  if (/^\d+$/.test(part)) {
    return [Number(part)]
  }

  throw new ValidationError(
    part.includes("-") ? `Invalid range: "${part}"` : `Invalid message number: "${part}"`,
  )
}

/**
 * Parse a message spec like "1,3-4,7" into a sorted array of 0-based indices.
 * Message numbers in the spec are 1-based (user-facing). The keywords "even"
 * and "odd" expand to all even/odd message numbers.
 * Throws if a range has start > end or if any number is out of bounds.
 */
export function parseMessageSpec(spec: string, msgCount: number): number[] {
  const parts = spec.replaceAll(" ", "").split(",").filter((p) => p.length > 0)
  const numbers = parts.flatMap((part) => parsePart(part, msgCount))
  const indices = [...new Set(numbers)].sort((a, b) => a - b)

  for (const num of indices) {
    if (num < 1 || num > msgCount) {
      throw new ValidationError(
        `Message ${num} does not exist (chat has ${msgCount} messages)`,
      )
    }
  }

  return indices.map((n) => n - 1) // make 0-indexed
}
