import { ValidationError } from "@cliffy/command"
import * as R from "remeda"

const parsePart = (part: string): number[] => {
  if (part.includes("-")) {
    const [startStr, endStr] = part.split("-")
    const start = parseInt(startStr, 10)
    const end = parseInt(endStr, 10)
    if (isNaN(start) || isNaN(end)) {
      throw new ValidationError(`Invalid range: "${part}"`)
    }
    if (start > end) {
      throw new ValidationError(`Invalid range: start > end in "${part}"`)
    }
    return R.range(start, end + 1)
  }
  const num = parseInt(part, 10)
  if (isNaN(num)) {
    throw new ValidationError(`Invalid message number: "${part}"`)
  }
  return [num]
}

/**
 * Parse a message spec like "1,3-4,7" into a sorted array of 0-based indices.
 * Message numbers in the spec are 1-based (user-facing).
 * Throws if a range has start > end or if any number is out of bounds.
 */
export function parseMessageSpec(spec: string, msgCount: number): number[] {
  const indices = R.pipe(
    spec.replaceAll(" ", "").split(","),
    R.filter((p) => p.length > 0),
    R.flatMap(parsePart),
    R.unique(),
    R.sortBy(R.identity()),
  )

  for (const num of indices) {
    if (num < 1 || num > msgCount) {
      throw new ValidationError(
        `Message ${num} does not exist (chat has ${msgCount} messages)`,
      )
    }
  }

  return R.map(indices, (n) => n - 1) // make 0-indexed
}
