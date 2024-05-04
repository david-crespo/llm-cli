# llm-cli

A simple but full-featured CLI powered by Deno for chatting with LLMs. A few hundred lines of TypeScript in a single file.

Thanks to [Justin Bennett](https://github.com/zephraph) for the
[script](https://github.com/zephraph/deno.run/blob/0972d0cd3d8f050cb11c3a6d1c1c201608d100a9/chat-gpt.ts)
that inspired this as well as the idea of piping markdown output to
[`glow`](https://github.com/charmbracelet/glow).

https://github.com/david-crespo/llm-cli/assets/3612203/31cfa0cb-3efc-4171-88f7-72de253bb255

## Features

### Supports GPT and Claude

<img width="604" alt="image" src="https://github.com/david-crespo/llm-cli/assets/3612203/a91c35de-8b5a-4fa9-9d11-32f0c4aa86a0" />

### Beautiful output powered by markdown

<img width="632" alt="image" src="https://github.com/david-crespo/llm-cli/assets/3612203/2574b335-6aeb-4e35-916e-dc0467bfbfb2" />

### Continue chat with replies

<img width="537" alt="image" src="https://github.com/david-crespo/llm-cli/assets/3612203/535e1c48-95be-46aa-891d-3254ddc87bc8" />

### Read input from stdin

<img width="620" alt="image" src="https://github.com/david-crespo/llm-cli/assets/3612203/c5dc783c-b754-454a-9765-9363624fda80">

### Upload chat to GitHub Gist for sharing or permanent storage

https://gist.github.com/david-crespo/a2bf06be5db310db967b2e35f6140da2

<img width="583" alt="image" src="https://github.com/david-crespo/llm-cli/assets/3612203/a45e1041-ae5b-498f-abea-e9166c4d0112">

### Limitations

No vision, no streaming responses (yet). No history of previous chats; only the current conversation is stored.

## Setup

### API keys

You will need OpenAI and/or Anthropic API keys. The script expects these to be in the usual `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` env vars.

### Dependencies

- [Deno](https://docs.deno.com/runtime/manual) (essential)
- [`glow`](https://github.com/charmbracelet/glow) (terminal markdown renderer, nearly
  essential)
  - You can do without `glow` if you like reading raw markdown or you have some other tool
    for rendering markdown in the terminal
- [`gh`](https://cli.github.com/) (GitHub CLI, optional)
  - Only needed if you want to upload chats as GitHub gists
  - You'll need to be logged in with it
    ([`gh auth login`](https://cli.github.com/manual/gh_auth_login))

### Installation

Download `main.ts` (whether directly or by cloning the repo). Then you just need a way to
run the script and pipe the output to `glow`. The way I do this is with this function in my
`.zprofile`:

```bash
function ai() {
  ~/repos/llm-cli/main.ts "$@" | glow
}
```

The `"$@:"` means pipe all command-line arguments to `ai` straight to `main.ts`.

You'll need to `chmod +x` the script in order to be able to execute it directly like above.
Otherwise, you could run it with `deno run path/to/main.ts`, but that is less convenient
because you'll have to set all the permissions I've set in the shebang line.

## Contributions

This is mostly for me (though I'd be thrilled if people find it useful), so I'm not really
interested in changes that make this tool more general-purpose unless a) I want to use them,
b) they don't make the interface any more complicated. The open issues include features I'd
be interested in adding.
