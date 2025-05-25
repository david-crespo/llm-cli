# llm-cli

A simple but full-featured CLI powered by Deno for chatting with LLMs.

Thanks to [Justin Bennett](https://github.com/zephraph) for the
[script](https://github.com/zephraph/deno.run/blob/0972d0cd3d8f050cb11c3a6d1c1c201608d100a9/chat-gpt.ts)
that inspired this as well as the idea of piping markdown output to
[`glow`](https://github.com/charmbracelet/glow).

<img width="664" alt="image" src="https://github.com/user-attachments/assets/4f45bb8a-7568-43b6-a1b0-5ce76fd8fc1b" />

## Features

### Supports a bunch of models

And it's easy to add more.

<img width="668" alt="output of models command showing table of supported models" src="https://github.com/user-attachments/assets/95880d8a-b4fc-4095-8d08-b4a920125a11" />


### Beautiful output powered by markdown

<img width="711" alt="image" src="https://github.com/user-attachments/assets/0acab93c-4062-46db-9779-8e48f9ccc1e9" />

### Continue chat with replies

<img width="668" alt="image" src="https://github.com/user-attachments/assets/8ff7b591-9690-4798-bd5e-f45d52206768" />

### Read input from stdin

<img width="668" alt="image" src="https://github.com/user-attachments/assets/84f64f93-6d56-483f-984e-42ce1eea5235" />


### Upload chat to GitHub Gist for sharing or permanent storage

https://gist.github.com/david-crespo/a2bf06be5db310db967b2e35f6140da2

<img width="583" alt="image" src="https://github.com/david-crespo/llm-cli/assets/3612203/a45e1041-ae5b-498f-abea-e9166c4d0112">

### Limitations

No vision, no streaming responses (yet).

## Setup

### API keys

Set any or all of these, depending on which models you want to use. It is often
convenient to put them in a `.env` file like below and call `source .env`.

```sh
export OPENAI_API_KEY=abc-123
export ANTHROPIC_API_KEY=def-456
export GEMINI_API_KEY=ghi-789
```

The script does not automatically pick up a `.env` file; the variables need to
be set in the environment.

### Dependencies

- [Deno](https://docs.deno.com/runtime/manual) (essential)
- [`glow`](https://github.com/charmbracelet/glow) (terminal markdown renderer)
  - You can do without `glow` if you like reading raw markdown or you pipe
    output to some other tool for rendering markdown in the terminal
- [`gh`](https://cli.github.com/) (GitHub CLI, optional)
  - Only needed if you want to upload chats as GitHub gists
  - You'll need to be logged in ([`gh auth login`](https://cli.github.com/manual/gh_auth_login))

### Installation

Clone the repo. Then you just need a way to run `main.ts` and pipe the output to
`glow`. I use this function in my `.zprofile`:

```bash
function ai() {
  source ~/path/to/.env
  ~/repos/llm-cli/main.ts "$@"
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
