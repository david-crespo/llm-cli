import assert from "node:assert/strict"
import { mock, test } from "node:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { errorIncluding } from "./testing.ts"
import { ValidationError } from "./errors.ts"
import {
  configPath,
  ensureConfigFile,
  getApiKey,
  maskKey,
  profilesReport,
  resolveProfile,
} from "./config.ts"

const envNames = [
  "XDG_CONFIG_HOME",
  "LLM_CLI_PROFILE",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
]

/**
 * Run `fn` with XDG_CONFIG_HOME in a fresh temp dir holding `contents` as the
 * config file (no file if undefined), and with `env` as the only key and
 * profile env vars set.
 */
async function withConfig(
  contents: string | undefined,
  env: Record<string, string>,
  fn: () => Promise<void>,
  mode = 0o600,
) {
  const old = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
  const configHome = mkdtempSync(join(tmpdir(), "llm-config-test-"))
  for (const name of envNames) delete process.env[name]
  Object.assign(process.env, env, { XDG_CONFIG_HOME: configHome })
  if (contents !== undefined) {
    mkdirSync(join(configHome, "llm-cli"))
    writeFileSync(configPath(), contents)
    chmodSync(configPath(), mode)
  }
  try {
    await fn()
  } finally {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(configHome, { recursive: true })
  }
}

const twoProfiles = `
default_profile = "personal"

[profiles.personal]
anthropic = "sk-ant-personal-0000000000"

[profiles.oxide]
anthropic = "sk-ant-oxide-1111111111"
openai = "sk-oxide-2222222222222"
`

test("an explicit profile beats the chat's, which beats the default", async () => {
  await withConfig(twoProfiles, {}, async () => {
    assert.deepEqual(await resolveProfile(undefined), "personal")
    assert.deepEqual(await resolveProfile(undefined, "oxide"), "oxide")
    assert.deepEqual(await resolveProfile("personal", "oxide"), "personal")
  })
  await withConfig(twoProfiles, { LLM_CLI_PROFILE: "oxide" }, async () => {
    assert.deepEqual(await resolveProfile(undefined, "personal"), "oxide")
    // --profile beats LLM_CLI_PROFILE
    assert.deepEqual(await resolveProfile("personal"), "personal")
  })
})

test("a single profile is used without default_profile", async () => {
  await withConfig('[profiles.only]\nopenai = "sk-x"', {}, async () => {
    assert.deepEqual(await resolveProfile(undefined), "only")
  })
})

test("a profile named default is used without default_profile", async () => {
  await withConfig("[profiles.work]\n[profiles.default]", {}, async () => {
    assert.deepEqual(await resolveProfile(undefined), "default")
  })
  // default_profile still wins
  await withConfig(
    'default_profile = "work"\n[profiles.work]\n[profiles.default]',
    {},
    async () => {
      assert.deepEqual(await resolveProfile(undefined), "work")
    },
  )
})

test("several profiles and no default is an error", async () => {
  await withConfig("[profiles.a]\n[profiles.b]", {}, async () => {
    await assert.rejects(
      () => resolveProfile(undefined),
      errorIncluding(ValidationError, "No profile selected and no default among a, b"),
    )
    // the chat's profile or an explicit one still works
    assert.deepEqual(await resolveProfile(undefined, "a"), "a")
    assert.deepEqual(await resolveProfile("b"), "b")
    // ai profiles reports it instead of failing
    assert.match(await profilesReport(undefined), /No profile selected/)
  })
})

test("env vars only without a file or without profiles", async () => {
  for (const contents of [undefined, "", "[profiles]"]) {
    await withConfig(contents, {}, async () => {
      assert.deepEqual(await resolveProfile(undefined), undefined)
    })
  }
})

test("naming a profile that doesn't exist lists the ones that do", async () => {
  await withConfig(twoProfiles, {}, async () => {
    await assert.rejects(
      () => resolveProfile("work"),
      errorIncluding(ValidationError, 'Profile "work" not found in'),
    )
    await assert.rejects(
      () => resolveProfile("work"),
      errorIncluding(ValidationError, "Profiles: personal, oxide"),
    )
  })
  await withConfig(twoProfiles, { LLM_CLI_PROFILE: "work" }, async () => {
    await assert.rejects(
      () => resolveProfile(undefined),
      errorIncluding(ValidationError, 'Profile "work" not found'),
    )
  })
  await withConfig(undefined, {}, async () => {
    await assert.rejects(
      () => resolveProfile("work"),
      errorIncluding(ValidationError, "Run `ai profiles` to create it"),
    )
  })
})

test("a chat's profile that no longer exists is an error", async () => {
  await withConfig(twoProfiles, {}, async () => {
    await assert.rejects(
      () => resolveProfile(undefined, "gone"),
      errorIncluding(ValidationError, 'This chat used profile "gone"'),
    )
  })
})

test("default_profile must name a profile", async () => {
  await withConfig('default_profile = "nope"\n[profiles.a]', {}, async () => {
    await assert.rejects(
      () => resolveProfile(undefined),
      errorIncluding(ValidationError, 'default_profile "nope" is not a profile'),
    )
  })
})

test("the schema rejects unknown providers, non-string keys, and bad TOML", async () => {
  for (const [contents, message] of [
    ['[profiles.a]\nantrhopic = "x"', "profiles.a.antrhopic must be removed"],
    ["[profiles.a]\nopenai = 1", "profiles.a.openai must be a string"],
    ["default = 1", "default must be removed"],
    ["[profiles.a\n", "config.toml: Invalid TOML"],
  ]) {
    await withConfig(contents, {}, async () => {
      await assert.rejects(
        () => resolveProfile(undefined),
        errorIncluding(ValidationError, message),
      )
    })
  }
})

test("getApiKey prefers the profile's key over the env var", async () => {
  await withConfig(twoProfiles, { ANTHROPIC_API_KEY: "sk-ant-env" }, async () => {
    assert.deepEqual(await getApiKey("anthropic", "oxide"), "sk-ant-oxide-1111111111")
    assert.deepEqual(await getApiKey("anthropic", undefined), "sk-ant-env")
  })
})

test("getApiKey falls back to the env var when the profile lacks the provider", async () => {
  await withConfig(twoProfiles, { GEMINI_API_KEY: "gemini-env" }, async () => {
    assert.deepEqual(await getApiKey("google", "personal"), "gemini-env")
  })
})

test("getApiKey's error names the profile, the file, and the env var", async () => {
  await withConfig(twoProfiles, {}, async () => {
    await assert.rejects(
      () => getApiKey("openai", "personal"),
      errorIncluding(
        ValidationError,
        'No openai key in profile "personal" (' + configPath(),
      ),
    )
    await assert.rejects(
      () => getApiKey("openai", "personal"),
      errorIncluding(ValidationError, "and OPENAI_API_KEY is not set"),
    )
  })
  await withConfig(undefined, { OPENAI_API_KEY: "" }, async () => {
    await assert.rejects(
      () => getApiKey("openai", undefined),
      errorIncluding(ValidationError, "OPENAI_API_KEY is not set and no profile is in use"),
    )
  })
})

test("getApiKey rejects an unknown provider", async () => {
  await assert.rejects(() => getApiKey("nope", undefined), errorIncluding(Error, "'nope'"))
})

test("maskKey keeps the first 6 and last 4 characters", () => {
  assert.deepEqual(maskKey("sk-ant-api03-abcdefghijx4f2"), "sk-ant…x4f2")
  assert.deepEqual(maskKey("short"), "…")
})

test("a config file others can read gets a warning", async () => {
  for (const [mode, warns] of [
    [0o644, true],
    [0o600, false],
  ] as const) {
    await withConfig(
      twoProfiles,
      {},
      async () => {
        const error = mock.method(console, "error", () => {})
        try {
          await resolveProfile(undefined)
          // read once, even when asked again
          await getApiKey("anthropic", "personal")
          assert.deepEqual(error.mock.callCount(), warns ? 1 : 0)
          if (warns) {
            assert.match(String(error.mock.calls[0].arguments[0]), /readable by others/)
          }
        } finally {
          error.mock.restore()
        }
      },
      mode,
    )
  }
})

test("ensureConfigFile creates a private template with one empty profile", async () => {
  await withConfig(undefined, {}, async () => {
    assert.deepEqual(ensureConfigFile(), true)
    assert.deepEqual(statSync(configPath()).mode & 0o777, 0o600)
    assert.deepEqual(statSync(join(configPath(), "..")).mode & 0o777, 0o700)
    assert.deepEqual(await resolveProfile(undefined), "default")
    assert.deepEqual(ensureConfigFile(), false)
    assert.match(readFileSync(configPath(), "utf8"), /\[profiles\.default\]/)
  })
})

test("profilesReport shows where each provider's key comes from", async () => {
  await withConfig(twoProfiles, { GEMINI_API_KEY: "gemini-env" }, async () => {
    const report = await profilesReport("oxide")
    assert.deepEqual(
      report.split("\n").slice(1).join("\n"),
      `
personal (default)
  anthropic   sk-ant…0000
  openai      —
  google      env
  openrouter  —

oxide (active)
  anthropic   sk-ant…1111
  openai      sk-oxi…2222
  google      env
  openrouter  —`,
    )
  })
})
