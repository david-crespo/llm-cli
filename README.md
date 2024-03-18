# LLM CLI

TODO: include screenshot of help output and a gif or video or asciicinema of a conversation

## Features

- Dead simple: less than 300 lines of TypeScript
- Supports GPT and Claude
- Beautiful markdown output
- Pipe input from stdin
- Current conversation persisted locally
- Upload conversation to GitHub gist for sharing or permanent storage

## Setup

### API keys

You will need API keys for the OpenAI and/or Anthropic API. If you only want to use one or
the other, that will work fine — you'll get an error only if you try to use the API you
don't have a key for. The script expects these to be in the usual `OPENAI_API_KEY` and
`ANTHROPIC_API_KEY` env vars. You can set the env vars any way you want, or you can create a
`.env` file next to `main.ts` and put the keys in there and things should just work.

### Dependencies

- [Deno](https://docs.deno.com/runtime/manual) (essential)
- [`glow`](https://github.com/charmbracelet/glow) (terminal markdown renderer, nearly
  essential)
  - You can do without `glow` if either you don't mind reading raw markdown or you have some
    other tool for rendering markdown in the terminal)
- [`gh`](https://cli.github.com/) (GitHub CLI, optional)
  - Only needed if you want to upload chats as GitHub gists
  - You'll need to be logged in with it
    ([`gh auth login`](https://cli.github.com/manual/gh_auth_login)).

### Installation

Once you have the dependencies and download `main.ts` (whether directly or by cloning the
repo), you just need a way to run the script and pipe the output to `glow`. The way I do
this is with this function in my `.zprofile`:

```bash
function ai() {
  ~/repos/llm-cli/main.ts "$@" | glow
}
```

The `"$@:` means pipe all command-line arguments to `ai` straight to `main.ts`.

You'll need to `chmod +x` the script in order to be able to execute it directly like in the
above function. Otherwise, you could run it with `deno run path/to/main.ts`, but that is
inconvenient because you have to set all the permissions I've set in the shebang line.

## Contributions

This is mostly for me (though I'd be thrilled if people find it useful), so I'm not really
interested in changes that make this tool more general-purpose unless a) I want to use them,
b) they don't make the interface any more complicated.
