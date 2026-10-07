# contextsbane_9000

A simple and savage context manager with aggressive truncation and thread compaction.

## Tools

1. **Clip.** A tool result longer than `max_result_bytes` is cut down to
   that size by removing its middle. With the default 20,000, the model sees
   the result's first 15,000 bytes, a note saying how many bytes were removed,
   and its last 5,000 bytes. Important info is most likely to be in the beginning, and then the end of a tool result.
2. **Compact.** Once the conversation grows past `compact_at_tokens`
   (default 64,000), it's reduced into the start + summary + end:
   - **the start** - the system prompt and the first user message
   - **the end** - the most recent steps, up to about `keep_recent_tokens`
     (default 16,000). Kept as is.
   - **the summary** - a cheap model on the same provider rewrites it
     as one summary message: the facts it found (copied exactly), what it
     has done, what it decided and why, and what's left, including
     approaches that failed.

   Each summary and
   the text it was made from are saved under the trial's
   `driver_state/contextsbane_9000/`.

## Rationale

- **Cachemaxxing.** Cached input costs a tenth (or less) of fresh input, and
  the provider caches the longest unchanged prefix. Clipping touches only
  new results at the end of the conversation, and compaction rewrites the
  prefix rarely and all at once, so between compactions every turn reads
  its prefix from cache without any cache breakage.
- **Stay well under long-context pricing.** The reference target's price
  doubles past 272k input tokens; compacting at 64k keeps every call far
  below that, and keeps each turn's (cached) re-read small.
- **The task is never summarised.** The system prompt and first user
  message carry the policy and the instructions verbatim, always.
- **Calls stay paired.** The kept tail starts on a whole step, so no tool
  result is ever kept without the call that asked for it.

## Config

| key                    | default | what it does                                                                                         |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `max_result_bytes`     | `20000` | tool results over this are clipped to it                                                             |
| `compact_at_tokens`    | `64000` | compact once the conversation's estimate (bytes / 4) passes this                                     |
| `keep_recent_tokens`   | `16000` | how much of the recent conversation compaction keeps whole                                           |
| `summary_result_bytes` | `8000`  | each tool result's cap in what the summariser reads                                                  |
| `summary_model`        | `""`    | the summariser; empty picks `gpt-6-luna`, `claude-haiku-4-5`, or `gemini-3.5-flash-lite` by provider |

- **Lane**: [`engines/litellm`](../../engines/litellm). Chat messages carry
  no OpenAI reasoning items or Anthropic thinking blocks; see the engine's
  README for the trade.
- **Files**: `driver.py`, `test_contextsbane_9000.py` (`uv run pytest drivers`).

```
bin/suite smoke_tau --driver contextsbane_9000
bin/suite tau_banking --driver contextsbane_9000 --count 2
bin/suite toolathlon_local --driver contextsbane_9000 --count 2
```

**Make your own ContextsBane**: copy the directory and change one layer at a time. Where
to look first: the summary prompt (`SUMMARY_INSTRUCTIONS`), by reading the
saved summaries next to the steps that followed them and asking what the
agent lost; `compact_at_tokens`, by trading cost per task against score on
the results site; and `max_result_bytes`, by checking what clipped results
cut. Keep each change general: the rules ask for a context manager that
works on any task, not one tuned to these benchmarks.
