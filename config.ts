import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import process from "node:process"

import { isErrno, ValidationError } from "./errors.ts"

export const keyProviders = ["anthropic", "openai", "google", "openrouter"] as const
type KeyProvider = (typeof keyProviders)[number]

const envVars: Record<KeyProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  // doesn't match the provider id
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
}

const isKeyProvider = (provider: string): provider is KeyProvider =>
  (keyProviders as readonly string[]).includes(provider)

/** API keys by provider id */
export type Profile = Partial<Record<KeyProvider, string>>

export type Config = {
  default_profile?: string
  profiles?: Record<string, Profile>
}

export function configPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(configHome, "llm-cli", "config.toml")
}

/** `path` with the home dir shortened to `~`, for messages */
function displayPath(path: string): string {
  const home = homedir()
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path
}

// Keyed by path so tests can point XDG_CONFIG_HOME somewhere else. Holds the
// promise so concurrent callers (summaries run in parallel) share one read and
// one permissions warning.
let cache: { path: string; config: Promise<Config | undefined> } | undefined

/** The parsed config file, or undefined if there isn't one */
export function loadConfig(): Promise<Config | undefined> {
  const path = configPath()
  if (cache?.path !== path) cache = { path, config: readConfig(path) }
  return cache.config
}

async function readConfig(path: string): Promise<Config | undefined> {
  let contents: string
  try {
    contents = readFileSync(path, "utf8")
  } catch (e) {
    if (isErrno(e, "ENOENT")) return undefined
    throw e
  }

  if (statSync(path).mode & 0o077) {
    console.error(
      `warning: ${displayPath(path)} is readable by others; run chmod 600 on it`,
    )
  }

  // Only loaded when a key is needed, so commands like `ai models` don't pay
  // for them at startup
  const [{ parse }, { type }] = await Promise.all([import("smol-toml"), import("arktype")])

  let raw: unknown
  try {
    raw = parse(contents)
  } catch (e) {
    throw new ValidationError(`${displayPath(path)}: ${(e as Error).message}`)
  }

  const profileSchema = type({
    // unknown keys are errors, so a typo like `antrhopic` doesn't read as a missing key
    "+": "reject",
    "anthropic?": "string",
    "openai?": "string",
    "google?": "string",
    "openrouter?": "string",
  })
  const config = type({
    "+": "reject",
    "default_profile?": "string",
    "profiles?": { "[string]": profileSchema },
  })(raw)
  if (config instanceof type.errors) {
    throw new ValidationError(`${displayPath(path)}: ${config.summary}`)
  }

  const names = Object.keys(config.profiles ?? {})
  if (config.default_profile && !names.includes(config.default_profile)) {
    throw new ValidationError(
      `${displayPath(path)}: default_profile "${config.default_profile}" is not a profile. ${listProfiles(names)}`,
    )
  }
  return config
}

const listProfiles = (names: string[]) =>
  names.length > 0 ? `Profiles: ${names.join(", ")}` : "There are no profiles."

/** default_profile, else the profile named "default", else the only profile */
function fallbackProfile(config: Config | undefined): string | undefined {
  const names = Object.keys(config?.profiles ?? {})
  if (config?.default_profile) return config.default_profile
  if (names.includes("default")) return "default"
  if (names.length === 1) return names[0]
  return undefined
}

/**
 * The profile to take keys from. First that applies: `flag` (--profile),
 * LLM_CLI_PROFILE, the profile recorded on the chat, then `fallbackProfile`.
 * Undefined, meaning env vars only, when there are no profiles. With several
 * profiles and no way to pick one, it's an error rather than a silent fallback
 * to env vars.
 */
export async function resolveProfile(
  flag: string | undefined,
  chatProfile?: string,
): Promise<string | undefined> {
  const config = await loadConfig()
  const names = Object.keys(config?.profiles ?? {})
  const path = displayPath(configPath())

  const explicit = flag || process.env.LLM_CLI_PROFILE
  if (explicit) {
    if (!config) {
      throw new ValidationError(
        `Profile "${explicit}" not found: ${path} doesn't exist. Run \`ai profiles\` to create it.`,
      )
    }
    if (!names.includes(explicit)) {
      throw new ValidationError(
        `Profile "${explicit}" not found in ${path}. ${listProfiles(names)}`,
      )
    }
    return explicit
  }

  if (chatProfile) {
    if (!names.includes(chatProfile)) {
      throw new ValidationError(
        `This chat used profile "${chatProfile}", which is not in ${path}. Pass --profile to use another.`,
      )
    }
    return chatProfile
  }

  const fallback = fallbackProfile(config)
  if (fallback) return fallback
  if (names.length > 0) throw new ValidationError(noDefaultMessage(names))
  return undefined
}

const noDefaultMessage = (names: string[]) =>
  `No profile selected and no default among ${names.join(", ")}. Pass --profile, set LLM_CLI_PROFILE, or set default_profile in ${displayPath(configPath())}.`

/** API key for `provider`: the profile's key if it has one, else the env var */
export async function getApiKey(
  provider: string,
  profile: string | undefined,
): Promise<string> {
  if (!isKeyProvider(provider)) {
    throw new Error(`No API key env var for provider '${provider}'`)
  }
  const envVar = envVars[provider]

  if (profile) {
    const key = (await loadConfig())?.profiles?.[profile]?.[provider]
    if (key) return key
  }

  const key = process.env[envVar]
  if (key) return key

  throw new ValidationError(
    profile
      ? `No ${provider} key in profile "${profile}" (${displayPath(configPath())}) and ${envVar} is not set`
      : `${envVar} is not set and no profile is in use (see \`ai profiles\`)`,
  )
}

/** First 6 and last 4 characters, enough to tell keys apart */
export const maskKey = (key: string) =>
  key.length < 16 ? "…" : `${key.slice(0, 6)}…${key.slice(-4)}`

const template = `# API keys for llm-cli, by profile. Key names are provider ids: anthropic,
# openai, google, openrouter. A provider missing from a profile falls back to
# its env var (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY,
# OPENROUTER_API_KEY).
#
# Pick a profile with --profile <name> or LLM_CLI_PROFILE. Otherwise a reply
# uses the chat's profile, and a new chat uses default_profile if it's set,
# else the profile named "default", else the only profile if there's just one.
# With several profiles and none of those, you have to pick one.

[profiles.default]
# anthropic = "sk-ant-..."
# openai = "sk-..."
# google = "..."
`

/** Create the config file from the template if it doesn't exist. Returns whether it did. */
export function ensureConfigFile(): boolean {
  const path = configPath()
  if (existsSync(path)) return false
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, template, { mode: 0o600, flag: "wx" })
  return true
}

/** Report for `ai profiles`: each profile and where each provider's key comes from */
export async function profilesReport(flag: string | undefined): Promise<string> {
  const config = await loadConfig()
  // An explicit profile is checked as usual, but having no default is reported
  // rather than thrown, since this is where you'd look to fix it
  const explicit = flag || process.env.LLM_CLI_PROFILE
  const active = explicit ? await resolveProfile(flag) : fallbackProfile(config)
  const lines = [displayPath(configPath())]

  const profiles = Object.entries(config?.profiles ?? {})
  if (profiles.length === 0) lines.push("", "No profiles")
  for (const [name, profile] of profiles) {
    const tags = [
      name === config?.default_profile && "default",
      name === active && "active",
    ].filter(Boolean)
    lines.push("", tags.length > 0 ? `${name} (${tags.join(", ")})` : name)
    for (const provider of keyProviders) {
      const key = profile[provider]
      const source = key ? maskKey(key) : process.env[envVars[provider]] ? "env" : "—"
      lines.push(`  ${provider.padEnd(12)}${source}`)
    }
  }

  if (!active) {
    const names = profiles.map(([name]) => name)
    lines.push(
      "",
      names.length > 0 ? noDefaultMessage(names) : "No profiles: keys come from env vars",
    )
  }
  return lines.join("\n")
}
