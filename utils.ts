import { ValidationError } from "@cliffy/command"
import * as R from "remeda"

const parsePart = (part: string): number[] => {
  if (/^\d+-\d+$/.test(part)) {
    const [startStr, endStr] = part.split("-")
    const start = Number(startStr)
    const end = Number(endStr)
    if (start > end) {
      throw new ValidationError(`Invalid range: start > end in "${part}"`)
    }
    return R.range(start, end + 1)
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
