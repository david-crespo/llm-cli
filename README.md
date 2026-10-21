# llm-cli

A simple but full-featured CLI for chatting with LLMs, written in TypeScript.

Thanks to [Justin Bennett](https://github.com/zephraph) for the
[script](https://github.com/zephraph/deno.run/blob/0972d0cd3d8f050cb11c3a6d1c1c201608d100a9/chat-gpt.ts)
that inspired this.

<img width="693" height="862" alt="Screenshot 2026-05-04 at 5 43 51 PM" src="https://github.com/user-attachments/assets/a9de8f7a-c719-45d4-a020-649c5798df48" />

## Features

### Supports a bunch of models

And it's easy to add more.

<img width="512" height="329" alt="Screenshot 2026-05-04 at 5 45 01 PM" src="https://github.com/user-attachments/assets/5602c814-c9fd-46cf-af87-5cb165ab4752" />

### Beautiful output powered by markdown

<img width="711" alt="image" src="https://github.com/user-attachments/assets/0acab93c-4062-46db-9779-8e48f9ccc1e9" />

Equations render as images in Ghostty and Kitty, with raw TeX elsewhere. Try
`npm run math-demo` for examples.

### Continue chat with replies

<img width="668" alt="image" src="https://github.com/user-attachments/assets/8ff7b591-9690-4798-bd5e-f45d52206768" />

### Read input from stdin

<img width="668" alt="image" src="https://github.com/user-attachments/assets/84f64f93-6d56-483f-984e-42ce1eea5235" />

### Attach images

Use `-i` / `--image` with a local file path or an HTTP(S) URL. Repeat the flag to attach
multiple images in order:

```sh
ai -i first.png --image second.jpg 'Compare these images'
ai -r -i third.webp 'How does this compare?'
```

Local files support PNG, JPEG, GIF, and WebP on all platforms. On macOS, `-i clipboard`
reads an image from the clipboard. Image input works with OpenAI, Anthropic, and Gemini chat
models. Image generation models currently accept text prompts only.

Local HEIC/HEIF files are automatically converted to JPEG using macOS's `sips`, preserving
the original file. If `sips` is unavailable, convert the image to JPEG or PNG first. Images
are not resized before sending.

GPT image inputs use `high` detail. Requests are checked against each provider's byte limits
before sending, including base64 encoding, prompt text, and any image history sent in that
request: OpenAI 512 MB, Claude 32 MB (also 10 MB per base64 image), and Gemini 20 MB.
Oversized inputs produce an error; compress the images or shorten the chat to retry. OpenAI
and Claude send HTTP(S) image URLs as references, so the remote image bytes are checked by
the provider. Gemini downloads URL images and includes their base64 bytes in the request
check.

### Upload chat to GitHub Gist for sharing or permanent storage

https://gist.github.com/david-crespo/a2bf06be5db310db967b2e35f6140da2

<img width="583" alt="image" src="https://github.com/david-crespo/llm-cli/assets/3612203/a45e1041-ae5b-498f-abea-e9166c4d0112">

### Limitations

No streaming responses (yet).

## Setup

### API keys

Keys go in `~/.config/llm-cli/config.toml` (or `$XDG_CONFIG_HOME/llm-cli/config.toml`),
grouped into profiles so you can keep separate keys, like personal and work. Run
`ai profiles` to create the file from a template (readable only by you) and to see where
each key will come from.

```toml
default_profile = "personal"

[profiles.personal]
anthropic = "sk-ant-..."
openai = "sk-..."
google = "..."

[profiles.work]
anthropic = "sk-ant-..."
```

Pick a profile with `--profile work` or `LLM_CLI_PROFILE=work`. Otherwise, a new chat uses
`default_profile`, else the profile named `default`, else the only profile if there's just
one. With several profiles and none of those, you have to pick one. `ai -r` uses the profile
the chat was started with, so a reply bills the same account.

A provider missing from the profile falls back to its env var: `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY`, or `OPENROUTER_API_KEY`. With no config file, the env
vars are all you need.

### Dependencies

- [Node](https://nodejs.org/) 24 or later (essential)
- [`gh`](https://cli.github.com/) (GitHub CLI, optional)
  - Only needed if you want to upload chats as GitHub gists
  - You'll need to be logged in
    ([`gh auth login`](https://cli.github.com/manual/gh_auth_login))

### Installation

I plan to publish this to npm so it can be installed with `npm install -g`. Until then,
clone the repo, then run `npm install` and `npm link` in it. That puts `ai` on your PATH,
running `main.ts` from the repo with `node` through its shebang line, so changes to the code
take effect right away. You could also run it with `node path/to/main.ts`.

## Contributions

This is mostly for me (though I'd be thrilled if people find it useful), so I'm not really
interested in changes that make this tool more general-purpose unless a) I want to use them,
b) they don't make the interface any more complicated. The open issues include features I'd
be interested in adding.
