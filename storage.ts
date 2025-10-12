import { type Chat } from "./types.ts"

const HISTORY_KEY = "llm-cli"
const HISTORY_LENGTH = 30

export const History = {
  read(): Chat[] {
    const contents = localStorage.getItem(HISTORY_KEY)
    if (!contents) return []
    return JSON.parse(contents, (key, value) => {
      if (
        (key === "createdAt" || key === "startedAt") &&
        typeof value === "string"
      ) {
        return new Date(value)
      }
      return value
    })
  },
  write(history: Chat[]) {
    // keep only the most recent N
    const truncated = history.slice(-HISTORY_LENGTH)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(truncated))
  },
  clear() {
    localStorage.removeItem(HISTORY_KEY)
  },
}
