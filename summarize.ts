import $ from "jsr:@david/dax@0.42"

import { cerebrasCreateMessage } from "./adapters.ts"
import { type Chat } from "./types.ts"
import { History } from "./storage.ts"

// use a fast model to summarize a chat for display purposes
async function summarize(chat: Chat): Promise<string> {
  const firstMsg = chat.messages[0].content
  const abridged = firstMsg.length > 100
    ? firstMsg.slice(0, 50) + "..." + firstMsg.slice(-50)
    : firstMsg
  // TODO: fall back to groq llama and then 4o-mini if cerebras key is missing
  const summary = await cerebrasCreateMessage({
    chat: {
      systemPrompt:
        "You are summarizing LLM chats based on excerpts for use in a TUI conversation list. Be concise and accurate. Include details like names to help identify that chat. Only provide the summary; do not include explanation or followup questions. Do not end with a period.",
      messages: [],
      createdAt: "",
    },
    input:
      `Please summarize an LLM chat based on the following excerpt from the first message. Use as few words as possible. Ideally 3-6 words, but up to 10. \n\n<excerpt>${abridged}</excerpt>`,
    model: "llama-3.3-70b",
    tools: [],
  })
  return summary.content
}

/** Create and save summaries for any chat without one */
export async function genMissingSummaries(history: Chat[]) {
  if (!Deno.env.get("CEREBRAS_API_KEY")) {
    $.logWarn("Skipping summarization:", "CEREBRAS_API_KEY not found")
    return
  }
  const pb = $.progress("Summarizing...")
  for (const chat of history) {
    if (!chat.summary) chat.summary = await summarize(chat)
  }
  History.write(history)
  pb.finish()
}
