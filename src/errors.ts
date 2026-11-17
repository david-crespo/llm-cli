/**
 * A problem with the user's input or state. The CLI reports these as a plain
 * error message instead of a stack trace.
 */
export class ValidationError extends Error {}

/** Whether `e` is a Node system error with the given code, like `ENOENT`. */
export function isErrno(e: unknown, code: string): boolean {
  return e instanceof Error && (e as { code?: unknown }).code === code
}
