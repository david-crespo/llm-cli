/**
 * A problem with the user's input or state. The CLI reports these as a plain
 * error message instead of a stack trace.
 */
export class ValidationError extends Error {}
