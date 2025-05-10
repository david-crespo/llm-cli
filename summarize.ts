import $ from "jsr:@david/dax@0.42"

import { groqCreateMessage } from "./adapters.ts"
import { type Chat } from "./types.ts"
import { History } from "./storage.ts"
import { resolveModel } from "./models.ts"

const HALF_EXCERPT = 100

/**
 * Use a fast model to summarize a chat for display purposes. Mutate the chat
 * directly
 */
async function summarize(chat: Chat): Promise<void> {
  const firstMsg = chat.messages[0].content
  const abridged = firstMsg.length > HALF_EXCERPT * 2
    ? firstMsg.slice(0, HALF_EXCERPT) + "..." + firstMsg.slice(-HALF_EXCERPT)
    : firstMsg
  // TODO: fall back to groq llama and then 4o-mini if cerebras key is missing
  const summary = await groqCreateMessage({
    chat: {
      systemPrompt:
        "You are summarizing LLM chats based on excerpts for use in a TUI conversation list. Be concise and accurate. Include details that help identify that chat. Only provide the summary; do not include explanation or followup questions. Do not end with a period.",
      messages: [],
      createdAt: new Date(),
    },
    input:
      `Please summarize an LLM chat based on the following excerpt from the first message. Use as few words as possible. Ideally 4-6 words, but up to 10. \n\n<excerpt>${abridged}</excerpt>`,
    model: resolveModel("llama-4-maverick"),
    tools: [],
  })

  chat.summary = summary.content
}

/** Create and save summaries for any chat without one */
export async function genMissingSummaries(history: Chat[]) {
  if (!Deno.env.get("GROQ_API_KEY")) {
    $.logWarn("Skipping summarization:", "GROQ_API_KEY not found")
    return
  }
  const pb = $.progress("Summarizing...")
  await Promise.all(history.filter((chat) => !chat.summary).map(summarize))
  History.write(history)
  pb.finish()
}
