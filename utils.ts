/** Integers from `start` up to but not including `end`. */
export function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i)
}

/** Keep the first item for each key, in order. */
export function uniqueBy<T>(items: T[], key: (item: T) => unknown): T[] {
  const seen = new Set<unknown>()
  return items.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((k) => [k, obj[k]])) as Pick<T, K>
}
