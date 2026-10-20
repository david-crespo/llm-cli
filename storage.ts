import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import process from "node:process"
import { isErrno } from "./errors.ts"
import { type Chat } from "./types.ts"

const HISTORY_KEY = "llm-cli"
const HISTORY_LENGTH = 30

export type StoredChat = Chat & {
  revision: string
  updatedAt: Date
  lastActiveAt: Date
}

function stateRoot(): string {
  const stateHome = process.env.XDG_STATE_HOME ||
    join(process.env.HOME!, ".local", "state")
  return join(stateHome, "llm-cli")
}

function chatsPath(): string {
  return join(stateRoot(), "chats")
}

function chatPath(id: string): string {
  return join(chatsPath(), `${id}.json`)
}

function imagesPath(): string {
  return join(stateRoot(), "images")
}

const pad = (n: number) => String(n).padStart(2, "0")

/** `20260923-143012-a-cat-in-a-hat.png`, local time */
export function imageFilename(prompt: string, date: Date, ext: string, index = 0) {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)
    .replace(/^-+|-+$/g, "")
  const suffix = index > 0 ? `-${index + 1}` : ""
  return [stamp, slug].filter(Boolean).join("-") + suffix + "." + ext
}

/**
 * Save a generated image under the state dir and return its absolute path.
 * Images are not pruned along with chat history.
 */
export function saveImage(
  bytes: Uint8Array,
  prompt: string,
  ext: string,
  index = 0,
  date = new Date(),
) {
  const dir = imagesPath()
  mkdirSync(dir, { recursive: true })
  for (let i = index;; i++) {
    const path = join(dir, imageFilename(prompt, date, ext, i))
    try {
      writeFileSync(path, bytes, { flag: "wx" })
      return path
    } catch (e) {
      // Another generation may have finished in the same second with the same slug.
      if (!isErrno(e, "EEXIST")) throw e
    }
  }
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
    if (message.role === "user") {
      const legacy = message as { image_url?: string }
      if (legacy.image_url !== undefined) {
        message.image_urls ??= [legacy.image_url]
        delete legacy.image_url
      }
    }
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
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${crypto.randomUUID()}`
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, path)
}

function removeLegacyHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY)
  } catch {
    // Legacy cleanup is best-effort once the file store is authoritative.
  }
}

function readChatFile(path: string): StoredChat {
  return toStoredChat(parseJson<StoredChat>(readFileSync(path, "utf8")))
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
    if (isErrno(e, "ENOENT")) return
    throw e
  }
}

function writeCurrent(id: string | undefined) {
  if (id) {
    writeJsonAtomic(currentPath(), { id })
  } else {
    rmSync(currentPath(), { force: true })
  }
}

function readCurrentId(): string | undefined {
  try {
    const current = parseJson<{ id?: string }>(readFileSync(currentPath(), "utf8"))
    return current.id
  } catch (e) {
    if (isErrno(e, "ENOENT")) return undefined
    throw e
  }
}

function chatsDirExists(): boolean {
  return statSync(chatsPath(), { throwIfNoEntry: false })?.isDirectory() ?? false
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
  mkdirSync(chatsPath(), { recursive: true })
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

  mkdirSync(chatsPath(), { recursive: true })
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
    rmSync(chatPath(chat.id))
  }
}

export const History = {
  list(): StoredChat[] {
    migrateIfNeeded()
    const chats: StoredChat[] = []
    for (const entry of readdirSync(chatsPath(), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
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
        if (!isErrno(e, "ENOENT")) throw e
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
      rmSync(chatPath(id), { force: true })
    }
    if (idSet.has(readCurrentId() ?? "")) {
      writeCurrent(this.list().at(-1)?.id)
    }
  },

  write(history: Chat[]) {
    rmSync(chatsPath(), { recursive: true, force: true })
    migrateFromHistory(history)
  },

  clear() {
    rmSync(chatsPath(), { recursive: true, force: true })
    mkdirSync(chatsPath(), { recursive: true })
    rmSync(currentPath(), { force: true })
    removeLegacyHistory()
  },
}
