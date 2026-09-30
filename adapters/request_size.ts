import { ValidationError } from "@cliffy/command"

const MB = 1_000_000
const encoder = new TextEncoder()

// Limits are measured on the UTF-8 JSON body, including base64, text, and schema.
// https://developers.openai.com/api/docs/guides/images-vision#image-input-requirements
// https://platform.claude.com/docs/en/build-with-claude/vision#request-limits
// https://ai.google.dev/gemini-api/docs/image-understanding
const requestLimitsMB = { OpenAI: 512, Claude: 32, Gemini: 20 } as const

export function validateRequestSize(
  provider: keyof typeof requestLimitsMB,
  body: unknown,
): void {
  const bytes = encoder.encode(JSON.stringify(body)).byteLength
  const limit = requestLimitsMB[provider]
  if (bytes > limit * MB) {
    throw new ValidationError(
      `${provider} request is larger than the ${limit} MB limit ` +
        `(${
          (bytes / MB).toFixed(2)
        } MB). Remove images or shorten the chat before sending.`,
    )
  }
}

/** The direct Claude API also limits each image after base64 encoding. */
export function validateClaudeImageSize(base64: string): void {
  if (encoder.encode(base64).byteLength > 10 * MB) {
    throw new ValidationError(
      "Claude image is larger than the 10 MB base64 limit. Compress the image before sending.",
    )
  }
}
