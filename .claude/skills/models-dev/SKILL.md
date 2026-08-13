---
name: models-dev
description: Look up current model IDs and prices from models.dev, e.g., to update the model list in models.ts. Use when adding a model, checking prices, or answering questions about what models a provider offers.
---

# models.dev model and price lookup

[models.dev](https://models.dev) is an open database of LLM models, prices, and
capabilities. The full dataset is one JSON file:

```sh
curl -s https://models.dev/api.json
```

The file is large (~180 providers), so save it to a temp file and query with jq rather than
reading it directly.

## Structure

Top-level keys are provider IDs. Each provider has `.name`, `.doc`, `.env`, and `.models`,
an object keyed by model ID. This CLI uses the first-party APIs, so the relevant providers
are `anthropic`, `openai`, and `google` (not `google-vertex`). Other OpenAI-compatible
providers are also present under their own keys if needed.

Model entry fields that matter here (prices are USD per million tokens):

| models.dev field   | `Model` field in `models.ts` |
| ------------------ | ---------------------------- |
| `.id`              | `key` (API model ID)         |
| `.cost.input`      | `input`                      |
| `.cost.output`     | `output`                     |
| `.cost.cache_read` | `input_cached`               |

Other useful fields: `.name`, `.release_date`, `.last_updated`, `.knowledge` (cutoff),
`.limit.context` / `.limit.output`, `.reasoning`, `.modalities`.

## Recipes

List a provider's models with prices, newest first:

```sh
jq -r '.anthropic.models | to_entries
  | sort_by(.value.release_date) | reverse | .[]
  | [.key, .value.release_date, .value.cost.input, .value.cost.output, .value.cost.cache_read]
  | @tsv' api.json
```

One model's full entry:

```sh
jq '.openai.models["gpt-5.6-terra"]' api.json
```

## Caveats

- Some providers list both a dated snapshot and an alias (e.g. `claude-haiku-4-5` and
  `claude-haiku-4-5-20251001`). Prefer the alias form, matching the existing entries in
  `models.ts`.
- Some models have tiered pricing (`.cost.tiers`, e.g. higher rates above 200k context).
  `models.ts` only supports flat pricing; use the base `.cost` numbers and note the
  discrepancy to the user if it's significant.
- `search_cost` (per-web-search pricing) is not in models.dev. Get it from the provider's
  pricing page, or copy from an existing same-provider entry in `models.ts` and flag that
  it's unverified.
- models.dev is community-maintained. For brand-new models, sanity-check surprising prices
  against the provider's pricing page.
- When editing `models.ts`, preserve the ordering rules described in the comment above the
  `models` array (preferred models first; substring matching depends on order).
