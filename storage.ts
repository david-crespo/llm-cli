import { type Chat } from "./types.ts"

const HISTORY_KEY = "llm-cli"

export const History = {
  read(): Chat[] {
    const contents = localStorage.getItem(HISTORY_KEY)
    if (!contents) return []
    return JSON.parse(contents)
  },
  write(history: Chat[]) {
    // only save up to 20 most recent chats
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-20)))
  },
  clear() {
    localStorage.removeItem(HISTORY_KEY)
  },
}
