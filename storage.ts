import { dirname, join } from "@std/path"
import { type Chat } from "./types.ts"

const HISTORY_KEY = "llm-cli"
const HISTORY_LENGTH = 30

function historyPath(): string {
  const stateHome = Deno.env.get("XDG_STATE_HOME") ||
    join(Deno.env.get("HOME")!, ".local", "state")
  return join(stateHome, "llm-cli", "history.json")
}

function parseHistory(contents: string): Chat[] {
  const chats: Chat[] = JSON.parse(contents, (key, value) => {
    if (
      (key === "createdAt" || key === "startedAt") &&
      typeof value === "string"
    ) {
      return new Date(value)
    }
    return value
  })
  // Backfill id for chats stored before we started writing it. Persisted on
  // the next History.write().
  for (const chat of chats) {
    if (!chat.id) chat.id = crypto.randomUUID()
  }
  return chats
}

function writeHistory(history: Chat[]) {
  // keep only the most recent N
  const truncated = history.slice(-HISTORY_LENGTH)
  const path = historyPath()
  Deno.mkdirSync(dirname(path), { recursive: true })
  // Atomic replace: write to a sibling temp file, then rename. A crash
  // before rename leaves the real file untouched; after rename, readers see
  // the complete new contents.
  const tmp = `${path}.tmp.${crypto.randomUUID()}`
  Deno.writeTextFileSync(tmp, JSON.stringify(truncated))
  Deno.renameSync(tmp, path)
}

function sameHistory(left: Chat[], right: Chat[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function removeLegacyHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY)
  } catch {
    // Legacy cleanup is best-effort once the file store is authoritative.
  }
}

export const History = {
  read(): Chat[] {
    try {
      return parseHistory(Deno.readTextFileSync(historyPath()))
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e
    }
    // Legacy fallback: migrate localStorage into the file store. Reads
    // thereafter skip this branch because the file is authoritative.
    const contents = localStorage.getItem(HISTORY_KEY)
    if (!contents) return []
    const history = parseHistory(contents)
    writeHistory(history)
    if (!sameHistory(history, parseHistory(Deno.readTextFileSync(historyPath())))) {
      throw new Error("History migration verification failed")
    }
    removeLegacyHistory()
    return history
  },
  write(history: Chat[]) {
    writeHistory(history)
  },
  clear() {
    // Leave an empty file as a tombstone so stale legacy localStorage does not
    // become visible again after clearing.
    writeHistory([])
    removeLegacyHistory()
  },
}
