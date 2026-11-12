import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { ThinkingLevel } from "@google/genai"

import { geminiThinkParams, withCitations } from "./gemini.ts"

test("Gemini default sends MEDIUM, or MINIMAL on flash-lite", () => {
  assert.deepEqual(geminiThinkParams("gemini-4-argon", undefined), {
    thinkingLevel: ThinkingLevel.MEDIUM,
    effort: "medium",
  })
  assert.deepEqual(geminiThinkParams("gemini-3.5-flash-lite", undefined), {
    thinkingLevel: ThinkingLevel.MINIMAL,
    effort: "minimal",
  })
})

test("--quick only uses MINIMAL on flash-lite", () => {
  assert.deepEqual(geminiThinkParams("gemini-3.7-flash", "off").effort, "low")
  assert.deepEqual(geminiThinkParams("gemini-3.1-pro-preview", "off").effort, "low")
  assert.deepEqual(geminiThinkParams("gemini-3.5-flash-lite", "off").effort, "minimal")
})

const chunk = (host: string, path = "") => ({
  web: { title: host, uri: `https://${host}/${path}` },
})

test("withCitations marks cited spans by byte offset into the joined answer", () => {
  const parts = [
    { text: "thinking", thought: true },
    // é is two bytes, so the first span ends at byte 13, not character 12
    { text: "Café opened. " },
    { text: "It closed." },
  ]
  const grounding = {
    groundingChunks: [
      chunk("a.com"),
      chunk("b.com", "1"),
      chunk("c.com"),
      chunk("b.com", "1"),
      chunk("uncited.com"),
    ],
    // Like real responses: no partIndex though the answer starts at part 1
    groundingSupports: [
      { segment: { startIndex: 14, endIndex: 24 }, groundingChunkIndices: [2, 0, 1] },
      { segment: { endIndex: 13 }, groundingChunkIndices: [3] },
    ],
  }
  assert.deepEqual(
    withCitations(parts, grounding),
    [
      "Café opened.[1] It closed.[1, 2, 3]",
      "",
      "### Sources",
      "",
      "1. [b.com](https://b.com/1)",
      "2. [c.com](https://c.com/)",
      "3. [a.com](https://a.com/)",
      "4. [uncited.com](https://uncited.com/)",
    ].join("\n"),
  )
})

test("withCitations places markers in a real grounded response", () => {
  const { candidates } = JSON.parse(
    readFileSync(
      new URL("../fixtures/gemini-grounded-response.json", import.meta.url),
      "utf8",
    ),
  )
  const output = withCitations(candidates[0].content.parts, candidates[0].groundingMetadata)
  const [answer, sources] = output.split("\n\n### Sources\n\n")
  for (const cited of [
    "a member of its Board of Directors[1].",
    "reports of two extramarital affairs[2, 3].",
    "raising significant national security concerns[4, 5].",
    "a subordinate Nvidia executive[5].",
    "as its first-ever Chair of the Board[1, 6].",
    "below $4 trillion[4, 7].",
  ]) {
    assert(answer.includes(cited), cited)
  }
  assert.deepEqual(
    sources.split("\n").map((line) => line.replace(/\]\(.*/, "")),
    [
      "1. [nvidia.com",
      "2. [axios.com",
      "3. [washingtonpost.com",
      "4. [aljazeera.com",
      "5. [cbsnews.com",
      "6. [businessinsider.com",
      "7. [theguardian.com",
    ],
  )
})

test("withCitations lists every source when there are no supports", () => {
  const grounding = { groundingChunks: [chunk("a.com"), chunk("b.com")] }
  assert.deepEqual(
    withCitations([{ text: "Answer." }], grounding),
    "Answer.\n\n### Sources\n\n1. [a.com](https://a.com/)\n2. [b.com](https://b.com/)",
  )
  assert.deepEqual(withCitations([{ text: "Answer." }], undefined), "Answer.")
})
