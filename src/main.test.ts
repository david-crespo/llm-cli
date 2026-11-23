import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { test, type TestContext } from "node:test"

import { History } from "./storage.ts"
import { testModel } from "./testing.ts"

/**
 * Run the CLI in a child process with its own temp state, config, and home
 * dirs, fake keys, and fake-fetch.ts answering provider requests. The env is
 * built from scratch so no real key or profile reaches the child.
 */
function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "llm-cli-main-"))
  t.after(() => rmSync(dir, { recursive: true }))
  const stateHome = join(dir, "state")
  const log = join(dir, "requests.jsonl")
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    XDG_STATE_HOME: stateHome,
    XDG_CONFIG_HOME: join(dir, "config"),
    ANTHROPIC_API_KEY: "test-key",
    OPENAI_API_KEY: "test-key",
    GEMINI_API_KEY: "test-key",
    FAKE_FETCH_LOG: log,
  }
  const preload = join(import.meta.dirname, "fake-fetch.ts")
  const main = join(import.meta.dirname, "main.ts")

  /** Run `ai args` with `stdin` piped in and check the exit code */
  function ai(args: string[], stdin = "", status = 0) {
    // stdin always ends: the CLI reads piped input to EOF
    const result = spawnSync(process.execPath, ["--import", preload, main, ...args], {
      env,
      input: stdin,
      encoding: "utf8",
    })
    assert.deepEqual(result.status, status, `ai ${args.join(" ")}: ${result.stderr}`)
    return result
  }

  /** The URL and JSON body of each provider request so far */
  const requests = (): Array<{ url: string; body: Record<string, unknown> }> =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : []

  /** Run `fn` in this process against the child's saved history */
  function inState<T>(fn: () => T): T {
    const old = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = stateHome
    try {
      return fn()
    } finally {
      if (old === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = old
    }
  }

  return { ai, requests, inState }
}

test("replies keep the model and search, thinking is sticky, and history is saved", (t) => {
  const { ai, requests, inState } = setup(t)
  const claude = testModel("anthropic")
  ai(["-m", claude.id, "-s", "--think-hard", "first"], "context")
  ai(["-r", "second"], "more")
  ai(["-r", "--think-default", "third"], "x")
  // --quick takes precedence over the other thinking flags
  ai(["-r", "--quick", "--think-hard", "fourth"], "y")

  const sent = requests()
  assert(
    sent.every((r) => r.url.startsWith("https://api.anthropic.com/")),
    sent.map((r) => r.url).join("\n"),
  )
  assert.deepEqual(
    sent.map(({ body }) => body.model),
    Array(4).fill(claude.key),
  )
  for (const { body } of sent) {
    const tools = (body.tools as Array<{ name: string }> | undefined)?.map(
      (tool) => tool.name,
    )
    assert(tools?.includes("web_search"), `search should stay on, got tools ${tools}`)
  }
  assert.deepEqual(
    sent.map(({ body }) => (body.output_config as { effort: string }).effort),
    ["xhigh", "xhigh", "medium", "low"],
  )
  assert.deepEqual((sent[0].body.messages as unknown[])[0], {
    role: "user",
    content: [{ type: "text", text: "context\n\nfirst" }],
  })

  const turns = ["context\n\nfirst", "more\n\nsecond", "x\n\nthird", "y\n\nfourth"]
  assert.deepEqual(
    inState(() => History.current()?.messages.map((m) => m.content)),
    turns.flatMap((turn) => [turn, "ok"]),
  )
})

test("subcommand flags that the root command also has still apply", (t) => {
  const { ai } = setup(t)
  ai(["-m", testModel("anthropic").id, "hi"], "q")
  assert.deepEqual(ai(["show", "--raw"]).stdout, "ok\n")
  const verbose = ai(["show", "-v"]).stdout
  assert(verbose.includes("> Thinking it over.\n\nok"), verbose)
  const models = ai(["models", "-v"]).stdout
  assert(models.includes("| Model key "), models)
})

test("ai models <id> shows the efforts the adapter sends for each thinking flag", (t) => {
  const { ai } = setup(t)
  const cases: Array<[model: string, think: string[]]> = [
    [
      "claude-sonnet-5-5",
      [
        "think: medium by default, --think for high, --think-hard for xhigh, --quick for low",
      ],
    ],
    ["gpt-6-luna", ["think: medium by default, --think-hard for high, --quick for none"]],
    ["gemini-4-neon", ["think: medium by default, --think-hard for high, --quick for low"]],
    [
      "gemini-3.5-flash-lite",
      ["think: minimal by default, --think for medium, --think-hard for high"],
    ],
    [
      "gemini-nano-banana-2.1",
      ["think: medium by default, --think-hard for high, --quick for minimal"],
    ],
    ["gpt-image-2.6-flare", []],
  ]
  for (const [model, think] of cases) {
    const lines = ai(["models", model]).stdout.split("\n")
    assert.deepEqual(
      lines.filter((line) => line.startsWith("think:")),
      think,
      model,
    )
  }
})

test("--json prints one JSON object, --raw prints only the text, and -e saves nothing", (t) => {
  const { ai, inState } = setup(t)

  const json = ai(["--json", "-e", "hi"], "q")
  assert.deepEqual(json.stderr, "")
  const message = JSON.parse(json.stdout)
  assert.deepEqual(json.stdout, JSON.stringify(message) + "\n")
  assert.deepEqual([message.role, message.content], ["assistant", "ok"])
  assert.deepEqual(
    inState(() => History.list()),
    [],
  )

  const gpt = testModel("openai")
  const raw = ai(["--raw", "-m", gpt.id, "hi"], "q")
  assert.deepEqual(raw.stdout, "ok\n")
  const meta = raw.stderr.trim()
  assert(
    meta.startsWith(`\`${gpt.id}\``) && meta.endsWith("| $0 | 0 -> 0"),
    `stderr should be the meta line, got ${JSON.stringify(raw.stderr)}`,
  )
})

test("input and chat errors exit 1 before any request", (t) => {
  const { ai, requests } = setup(t)
  const cases: Array<[string[], string, string]> = [
    [["hi"], "", "Piped input was empty"],
    [["-r", "hi"], "x", "Can't reply: no chat in progress"],
    [["show"], "", "No chat in progress"],
  ]
  for (const [args, stdin, error] of cases) {
    const { stderr } = ai(args, stdin, 1)
    assert(stderr.includes(error), `ai ${args.join(" ")}: ${stderr}`)
  }
  assert.deepEqual(requests(), [])
})

test("-r is refused while a background response is pending", (t) => {
  const { ai, requests, inState } = setup(t)
  inState(() =>
    History.save(
      {
        id: "bg",
        createdAt: new Date(),
        systemPrompt: "test",
        messages: [{ role: "user", content: "slow question", createdAt: new Date() }],
        background: {
          id: "resp_1",
          status: "queued",
          startedAt: new Date(),
          provider: "openai",
          modelId: testModel("openai").id,
        },
      },
      { current: true },
    ),
  )
  const { stderr } = ai(["-r", "hi"], "x", 1)
  assert(stderr.includes("pending background response"), stderr)
  assert.deepEqual(requests(), [])
})

test("image models support -r replies on image chats and refuse text-only chats or image-only prompts", (t) => {
  const { ai, requests } = setup(t)
  const banana = testModel("google", "image")
  const flare = testModel("openai", "image")

  ai(["-m", banana.id, "a fox"], "x")
  ai(["-r", "make it blue"], "x")

  const sent = requests()
  assert.deepEqual(sent.length, 2)
  assert.deepEqual(sent[0].body.input, "x\n\na fox")
  assert.deepEqual(sent[0].body.previous_interaction_id, undefined)
  assert.deepEqual(sent[1].body.input, "x\n\nmake it blue")
  assert.deepEqual(sent[1].body.previous_interaction_id, "int_1")

  // Replying to a text-only chat with an image model fails before requesting
  ai(["-m", testModel("anthropic").id, "tell me about foxes"], "x")
  const beforeCount = requests().length
  const textOnlyReply = ai(["-r", "-m", flare.id, "draw one"], "x", 1)
  assert(textOnlyReply.stderr.includes("chat has no previous image"), textOnlyReply.stderr)

  const noText = ai(["-m", flare.id, "-i", "https://example.com/a.png"], "", 1)
  assert(noText.stderr.includes("Image models require a text prompt"), noText.stderr)
  assert.deepEqual(requests().length, beforeCount)
})

test("ai gist only summarizes when creating an untitled gist without a saved summary", (t) => {
  const binDir = mkdtempSync(join(tmpdir(), "llm-cli-gh-"))
  t.after(() => rmSync(binDir, { recursive: true }))
  const ghPath = join(binDir, "gh")
  writeFileSync(ghPath, "#!/bin/sh\ncat >/dev/null\n")
  chmodSync(ghPath, 0o755)
  const oldPath = process.env.PATH
  process.env.PATH = `${binDir}:${oldPath}`
  t.after(() => {
    process.env.PATH = oldPath
  })

  const { ai, requests } = setup(t)
  ai(["hi"], "x")
  assert.deepEqual(requests().length, 1)

  ai(["gist", "-t", "Custom"])
  ai(["gist", "--id", "abc123"])
  assert.deepEqual(requests().length, 1)

  ai(["gist"])
  assert.deepEqual(requests().length, 2)
  ai(["gist"])
  assert.deepEqual(requests().length, 2)
})

test("a failed request reports status and body on stderr, leaves stdout empty, and saves the user message", (t) => {
  const { ai, inState } = setup(t)
  for (const model of [
    testModel("google").id,
    testModel("anthropic").id,
    testModel("openai").id,
  ]) {
    const failed = ai(["-m", model, "--raw", "FAIL_REQUEST"], "x", 1)
    assert.deepEqual(failed.stdout, "", model)
    assert.match(failed.stderr, /Request error: 500/, model)
    assert.match(failed.stderr, /"Internal error"/, model)
  }
  const jsonFailed = ai(["--json", "-e", "FAIL_REQUEST"], "x", 1)
  assert.deepEqual(jsonFailed.stdout, "")
  assert.match(jsonFailed.stderr, /"Internal error"/)

  assert.deepEqual(
    inState(() => History.current()?.messages.map((m) => [m.role, m.content])),
    [["user", "x\n\nFAIL_REQUEST"]],
  )
})
