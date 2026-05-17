import { dirname, join } from "@std/path"
import { type Chat } from "./types.ts"

const HISTORY_KEY = "llm-cli"
const HISTORY_LENGTH = 30

export type StoredChat = Chat & {
  revision: string
  updatedAt: Date
  lastActiveAt: Date
}

function stateRoot(): string {
  const stateHome = Deno.env.get("XDG_STATE_HOME") ||
    join(Deno.env.get("HOME")!, ".local", "state")
  return join(stateHome, "llm-cli")
}

function chatsPath(): string {
  return join(stateRoot(), "chats")
}

function chatPath(id: string): string {
  return join(chatsPath(), `${id}.json`)
}

function currentPath(): string {
  return join(stateRoot(), "current.json")
}

function parseJson<T>(contents: string): T {
  return JSON.parse(contents, (key, value) => {
    if (
      (key === "createdAt" || key === "startedAt" || key === "updatedAt" ||
        key === "lastActiveAt") &&
      typeof value === "string"
    ) {
      return new Date(value)
    }
    return value
  })
}

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function backfillLegacyMessageTimes(chats: Chat[], baseTime = Date.now()): Chat[] {
  const totalTicks = chats.reduce(
    (sum, chat) => sum + Math.max(1, chat.messages.length),
    0,
  )
  const startTime = baseTime - totalTicks
  let i = 0

  for (const chat of chats) {
    for (const message of chat.messages) {
      message.createdAt ??= new Date(startTime + i)
      i++
    }
    if (chat.messages.length === 0) i++
  }

  return chats
}

function normalizeChat(chat: Chat): Chat {
  chat.createdAt = date(chat.createdAt)
  for (const message of chat.messages) {
    if (message.createdAt) message.createdAt = date(message.createdAt)
  }
  return chat
}

function lastMessageTime(chat: Chat): Date | undefined {
  return chat.messages.at(-1)?.createdAt
}

function parseHistory(contents: string): Chat[] {
  const chats = parseJson<Chat[]>(contents)
  for (const chat of chats) {
    if (!chat.id) chat.id = crypto.randomUUID()
    normalizeChat(chat)
  }
  return backfillLegacyMessageTimes(chats)
}

function toStoredChat(chat: Chat | StoredChat): StoredChat {
  const now = new Date()
  const maybeStored = chat as Partial<StoredChat>
  normalizeChat(chat)
  return {
    ...chat,
    id: chat.id || crypto.randomUUID(),
    revision: maybeStored.revision ?? crypto.randomUUID(),
    updatedAt: maybeStored.updatedAt ?? now,
    lastActiveAt: maybeStored.lastActiveAt ?? lastMessageTime(chat) ?? chat.createdAt,
  }
}

function writeJsonAtomic(path: string, value: unknown) {
  Deno.mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${crypto.randomUUID()}`
  Deno.writeTextFileSync(tmp, JSON.stringify(value))
  Deno.renameSync(tmp, path)
}

function removeLegacyHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY)
  } catch {
    // Legacy cleanup is best-effort once the file store is authoritative.
  }
}

function readChatFile(path: string): StoredChat {
  return toStoredChat(parseJson<StoredChat>(Deno.readTextFileSync(path)))
}

function writeChatFile(chat: StoredChat): StoredChat {
  const stored: StoredChat = {
    ...chat,
    revision: crypto.randomUUID(),
    updatedAt: new Date(),
  }
  writeJsonAtomic(chatPath(stored.id), stored)
  return stored
}

function assertCurrentRevision(chat: StoredChat) {
  try {
    const current = readChatFile(chatPath(chat.id))
    if (current.revision !== chat.revision) {
      throw new Error(
        `Chat ${chat.id} changed concurrently; reload it before saving`,
      )
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return
    throw e
  }
}

function writeCurrent(id: string | undefined) {
  if (id) {
    writeJsonAtomic(currentPath(), { id })
  } else {
    try {
      Deno.removeSync(currentPath())
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e
    }
  }
}

function readCurrentId(): string | undefined {
  try {
    const current = parseJson<{ id?: string }>(Deno.readTextFileSync(currentPath()))
    return current.id
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return undefined
    throw e
  }
}

function removeIfExists(path: string, options?: Deno.RemoveOptions) {
  try {
    Deno.removeSync(path, options)
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e
  }
}

function chatsDirExists(): boolean {
  try {
    return Deno.statSync(chatsPath()).isDirectory
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false
    throw e
  }
}

function migrateFromHistory(history: Chat[]) {
  const truncated = history.slice(-HISTORY_LENGTH)
  for (const chat of truncated) normalizeChat(chat)
  backfillLegacyMessageTimes(truncated)
  const activeBase = Date.now() - truncated.length
  const storedChats = truncated.map((chat, index) => ({
    ...toStoredChat(chat),
    lastActiveAt: lastMessageTime(chat) ?? new Date(activeBase + index),
  }))
  Deno.mkdirSync(chatsPath(), { recursive: true })
  for (const chat of storedChats) {
    writeJsonAtomic(chatPath(chat.id), chat)
  }
  writeCurrent(storedChats.at(-1)?.id)
  removeLegacyHistory()
}

function migrateIfNeeded() {
  if (chatsDirExists()) return

  let contents: string | null = null
  try {
    contents = localStorage.getItem(HISTORY_KEY)
  } catch {
    contents = null
  }
  if (contents) {
    migrateFromHistory(parseHistory(contents))
    return
  }

  Deno.mkdirSync(chatsPath(), { recursive: true })
}

function sortChats(chats: StoredChat[]): StoredChat[] {
  return chats.sort((a, b) => {
    const active = a.lastActiveAt.getTime() - b.lastActiveAt.getTime()
    return active || a.createdAt.getTime() - b.createdAt.getTime()
  })
}

function prune(chats: StoredChat[]) {
  const toDelete = sortChats([...chats]).slice(0, -HISTORY_LENGTH)
  for (const chat of toDelete) {
    Deno.removeSync(chatPath(chat.id))
  }
}

export const History = {
  list(): StoredChat[] {
    migrateIfNeeded()
    const chats: StoredChat[] = []
    for (const entry of Deno.readDirSync(chatsPath())) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue
      chats.push(readChatFile(join(chatsPath(), entry.name)))
    }
    return sortChats(chats)
  },

  read(): StoredChat[] {
    return this.list()
  },

  current(): StoredChat | undefined {
    migrateIfNeeded()
    const id = readCurrentId()
    if (id) {
      try {
        return readChatFile(chatPath(id))
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e
      }
    }
    return undefined
  },

  findLatestBackground(): StoredChat | undefined {
    return this.list().findLast((chat) => chat.background)
  },

  save(chat: Chat | StoredChat, opts: { current?: boolean; touch?: boolean } = {}) {
    migrateIfNeeded()
    const stored = toStoredChat(chat)
    if ("revision" in chat) assertCurrentRevision(stored)
    if (opts.touch) stored.lastActiveAt = new Date()
    const saved = writeChatFile(stored)
    Object.assign(chat, saved)
    if (opts.current) writeCurrent(saved.id)
    prune(this.list())
    return saved
  },

  touch(id: string) {
    const chat = this.get(id)
    chat.lastActiveAt = new Date()
    const saved = writeChatFile(chat)
    writeCurrent(saved.id)
    return saved
  },

  get(id: string): StoredChat {
    migrateIfNeeded()
    return readChatFile(chatPath(id))
  },

  delete(ids: string[]) {
    migrateIfNeeded()
    const idSet = new Set(ids)
    for (const id of idSet) {
      try {
        Deno.removeSync(chatPath(id))
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e
      }
    }
    if (idSet.has(readCurrentId() ?? "")) {
      writeCurrent(this.list().at(-1)?.id)
    }
  },

  write(history: Chat[]) {
    removeIfExists(chatsPath(), { recursive: true })
    migrateFromHistory(history)
  },

  clear() {
    removeIfExists(chatsPath(), { recursive: true })
    Deno.mkdirSync(chatsPath(), { recursive: true })
    removeIfExists(currentPath())
    removeLegacyHistory()
  },
}
