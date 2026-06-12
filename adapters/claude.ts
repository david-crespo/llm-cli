import Anthropic from "@anthropic-ai/sdk"
import * as R from "remeda"
import { match } from "ts-pattern"

import { postprocessSchemaContent, prepareSchema } from "../schema.ts"
import { getCost } from "../models.ts"
import { parseDataUrl } from "../utils.ts"
import type { ChatInput, ThinkLevel } from "./types.ts"

function claudeMsg(
  role: "user" | "assistant",
  text: string,
  image_url?: string,
): Anthropic.MessageParam {
  const content: Anthropic.ContentBlockParam[] = text ? [{ type: "text", text }] : []

  if (image_url) {
    const dataUrl = parseDataUrl(image_url)
    const source: Anthropic.ImageBlockParam["source"] = dataUrl
      ? { type: "base64", media_type: dataUrl.mediaType, data: dataUrl.data }
      : { type: "url", url: image_url }
    content.unshift({ type: "image", source })
  }

  return { role, content }
}

function renderClaudeContentBlock(msg: Anthropic.Beta.Messages.BetaContentBlock) {
  if (msg.type === "text") {
    const citations = (msg.citations || [])
      .filter((c) => c.type === "web_search_result_location")
    if (citations.length === 0) return msg.text
    const unique = R.uniqueBy(citations, (c) => c.url)
    const sources = unique.map((c) => `[${c.title || c.url}](${c.url})`).join(" · ")
    return msg.text + " (" + sources + ")"
  } else if (msg.type === "server_tool_use" && msg.name === "web_search") {
    return `**Search:** ${(msg.input as { query: string }).query}`
  } else if (msg.type === "server_tool_use" && msg.name === "web_fetch") {
    return `**Fetch:** ${(msg.input as { url: string }).url}`
  }
}

type ClaudeThinkParams = {
  thinking: Anthropic.Beta.BetaThinkingConfigParam | undefined
  output_config: Anthropic.Beta.BetaOutputConfig | undefined
  max_tokens: number
}

function claudeThinkParams(key: string, think: ThinkLevel): ClaudeThinkParams {
  // Fable's thinking can't be turned off; on the other adaptive models we
  // want it on by default anyway
  const isSonnet = key === "claude-sonnet-4-6"
  const adaptive = key === "claude-fable-5" || key === "claude-opus-4-8" || isSonnet

  // SDK's non-streaming guard throws when max_tokens > ~21_333 (it assumes
  // 128k tokens/hour and refuses requests estimated to take >10 min).
  // Adaptive models think at effort high by default, so they need the bigger
  // cap whenever thinking isn't minimized.
  const max_tokens = think === "high" || (adaptive && think !== "off") ? 20_000 : 8_000

  if (think === undefined) {
    if (adaptive) {
      // Adaptive thinking, effort defaults to high. Set thinking only for
      // display: "summarized" — Fable and Opus default to "omitted", which
      // blanks the text --verbose shows.
      return {
        thinking: { type: "adaptive", display: "summarized" },
        output_config: undefined,
        max_tokens,
      }
    }
    return { thinking: undefined, output_config: undefined, max_tokens }
  }

  if (!adaptive) {
    const thinking = match(think)
      .returnType<Anthropic.Beta.BetaThinkingConfigParam>()
      .with("on", () => ({ type: "enabled", budget_tokens: 4000 }))
      .with("high", () => ({ type: "enabled", budget_tokens: 16000 }))
      .with("off", () => ({ type: "disabled" }))
      .exhaustive()
    return { thinking, output_config: undefined, max_tokens }
  }

  // Force display: "summarized" so --verbose shows reasoning. --quick lowers
  // effort rather than disabling thinking.
  const thinking: Anthropic.Beta.BetaThinkingConfigParam = {
    type: "adaptive",
    display: "summarized",
  }

  // Sonnet 4.6 doesn't support xhigh, but it does support max
  const effort = match(think)
    .with("on", () => "high" as const)
    .with("high", () => isSonnet ? "max" as const : "xhigh" as const)
    .with("off", () => "low" as const)
    .exhaustive()

  return { thinking, output_config: { effort }, max_tokens }
}

export async function claudeCreateMessage(
  { chat, model, config, signal, outputSchema }: ChatInput,
) {
  const toolsList: Anthropic.Beta.BetaToolUnion[] = []
  if (config.search) {
    toolsList.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 })
    toolsList.push({ type: "web_fetch_20260209", name: "web_fetch" })
    toolsList.push({ type: "code_execution_20260120", name: "code_execution" })
  }

  const { thinking, output_config, max_tokens } = claudeThinkParams(
    model.key,
    config.think,
  )

  const prep = outputSchema ? prepareSchema(outputSchema) : undefined
  const format: Anthropic.Beta.BetaJSONOutputFormat | undefined = prep
    ? { type: "json_schema", schema: prep.schema }
    : undefined

  const response = await new Anthropic().beta.messages.create({
    model: model.key,
    cache_control: { type: "ephemeral" },
    system: chat.systemPrompt,
    messages: chat.messages.map((m) =>
      claudeMsg(m.role, m.content, m.role === "user" ? m.image_url : undefined)
    ),
    max_tokens,
    thinking,
    output_config: format ? { ...output_config, format } : output_config,
    tools: toolsList.length > 0 ? toolsList : undefined,
    betas: ["code-execution-web-tools-2026-02-09"],
  }, { signal })

  const searches = response.usage.server_tool_use?.web_search_requests ?? 0

  const blocks = response.content.filter((msg) =>
    msg.type === "text" || (!prep && msg.type === "server_tool_use")
  )
    .map(renderClaudeContentBlock)
    .filter((x): x is string => !!x)

  // Join blocks, avoiding separators around punctuation/connectors
  let content = blocks.reduce((acc, block) => {
    if (!acc) return block
    if (/^[,;.!?]/.test(block)) return acc + block // no space before punctuation
    if (/^(and|or)\b/i.test(block)) return acc + " " + block // space before connectors
    return acc + "\n\n" + block
  }, "")

  if (prep) content = postprocessSchemaContent(content, prep.wrapped)
  const reasoning = response.content
    .filter((msg) => msg.type === "thinking")
    .map((msg) => msg.thinking)
    .join("\n\n")

  // unlike openapi, input_tokens is only cache misses
  const cache_miss = response.usage.input_tokens || 0
  const cache_hit = response.usage.cache_read_input_tokens || 0
  const cache_write = response.usage.cache_creation_input_tokens || 0

  const tokens = {
    // technically, cache writes cost 25% more than regular input tokens but I
    // don't want to build in the logic to count it
    input: cache_miss + cache_hit + cache_write,
    output: response.usage.output_tokens,
    input_cache_hit: cache_hit,
  }

  return {
    content,
    reasoning,
    tokens,
    cost: getCost(model, tokens, searches),
    stop_reason: response.stop_reason!, // always non-null in non-streaming mode
    searches: searches || undefined,
  }
}
