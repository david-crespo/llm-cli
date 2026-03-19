import $ from "@david/dax"

import { createMessage } from "./adapters.ts"
import { type Chat } from "./types.ts"
import { History } from "./storage.ts"
import { resolveModel } from "./models.ts"

const HALF_EXCERPT = 200

function abridge(content: string): string {
  return content.length > HALF_EXCERPT * 2
    ? content.slice(0, HALF_EXCERPT) + "..." + content.slice(-HALF_EXCERPT)
    : content
}

/**
 * Use a fast model to summarize a chat for display purposes. Returns the
 * summary without modifying the chat.
 */
export async function summarize(chat: Chat): Promise<string> {
  const abridged1 = abridge(chat.messages[0].content)
  const msg2 = chat.messages.at(1)?.content
  const abridged2 = msg2 ? abridge(msg2) : ""
  const summary = await createMessage({
    chat: {
      systemPrompt:
        "You are summarizing an LLM chat in as few words as possible. Ideally 4-6 words, but up to 10 if necessary. This is for a list of chats in an LLM client UI. You will receive an excerpt of the beginning and end of the first two messages. Be concise and accurate. Only provide the summary; do not include explanation or followup questions. Do not end with a period. Do not use slashes.",
      messages: [{
        role: "user",
        content: `<message-1>${abridged1}</message-1><message-2>${abridged2}</message-2>`,
      }],
      createdAt: new Date(),
    },
    model: resolveModel("flash"),
    config: { search: false, think: "off" },
  })

  return summary.content
}

/** Create and save summaries for any chat without one */
export async function genMissingSummaries(history: Chat[]) {
  const pb = $.progress("Summarizing...")
  await Promise.all((history
    .filter((chat) => !chat.summary))
    .map(async (chat) => {
      chat.summary = await summarize(chat)
    }))
  History.write(history)
  pb.finish()
}
