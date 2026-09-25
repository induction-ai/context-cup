import type { Language } from "./highlight";

/** The home page's code sample: a whole driver on the Python lane, its three
 *  files. It is the `keep_recent` example from docs/drivers.md, written
 *  against the same `ctx` as drivers/base_python; keep it runnable. */
export const SAMPLE_DRIVER: {
  file: string;
  language: Language;
  source: string;
}[] = [
  {
    file: "driver.py",
    language: "python",
    source: `from openai import OpenAI

from context_cup_engine import PythonContext


def run(ctx: PythonContext):
    """Every turn: decide what the model sees, then call it."""
    keep = int(ctx.config.get("keep", 3))
    conversation = ctx.view()
    results = [m for m in conversation.messages if m.role == "tool"]
    # Blank all but the most recent tool results.
    for message in results[:-keep]:
        message.text = "[dropped]"
    ctx.write(conversation)
    return OpenAI().responses.create(**ctx.context_payload)`,
  },
  {
    file: "package.json",
    language: "json",
    source: `{
  "private": true,
  "name": "@context-cup-drivers/keep_recent",
  "version": "0.1.0",
  "description": "Blanks all but the three most recent tool results.",
  "contextCup": {
    "kind": "driver",
    "extends": "@context-cup/engine-python",
    "providers": ["openai"],
    "config": { "keep": 3 }
  }
}`,
  },
  {
    file: "setup.sh",
    language: "bash",
    source: `#!/usr/bin/env bash
set -euo pipefail
# The Python engine installs no provider SDK; bring your own.
uv pip install --quiet --python "\${CC_CHAIN%%:*}/.venv/bin/python" openai`,
  },
];
