"""contextsbane_9000: clip long tool results, and summarise the middle of the
conversation once it grows past `compact_at_tokens`. README.md explains the
strategy; engines/litellm/README.md has everything `ctx` holds."""

import json
import sys
from pathlib import Path
from typing import Any

import openai

CLIP_MARKER = "\n\n[contextsbane_9000: {dropped} bytes cut from the middle of this result. If you need them, ask again for a narrower slice.]\n\n"
CLIP_PREFIX = "\n\n[contextsbane_9000:"
SUMMARY_PREFIX = "[contextsbane_9000: summary of the earlier conversation]\n\n"

SUMMARY_MODELS = {
    "openai": "gpt-6-luna",
    "anthropic": "claude-haiku-4-5",
    "gemini": "gemini-3.5-flash-lite",
}

SUMMARY_INSTRUCTIONS = """\
You are compacting the working memory of an AI agent partway through a task.
The agent will keep the task statement and its most recent steps; it will
see your summary in place of everything in between, and nothing else of it.

Write the summary from the agent's point of view, under these headings:

## Facts
Every concrete value the agent learned and may need again, verbatim: ids,
names, account and order numbers, amounts, dates, file paths, URLs, counts.

## Done
What has been completed, including every change made to the world (records
written, messages sent, files created) and its result.

## Commitments
What the agent told the user it would or would not do, decisions it made,
and policy rules it found apply here.

## Remaining
What is still to do, and anything that failed and why.

Be complete about facts and terse about everything else. Do not continue the
task; only summarise it."""


def clip(text: str, max_bytes: int) -> str:
    """Cut `text` to about `max_bytes` by removing its middle: keep the first
    75% of the budget from the start and the last 25% from the end, which
    often holds an error, a total, or a "page 3 of 7"."""
    raw = text.encode("utf-8")
    # Edits persist in context_messages, so a result clipped on an earlier
    # turn comes back with its marker; leave it as it is.
    if len(raw) <= max_bytes or CLIP_PREFIX in text:
        return text
    head = raw[: max_bytes * 3 // 4].decode("utf-8", errors="ignore")
    tail = raw[len(raw) - max_bytes // 4 :].decode("utf-8", errors="ignore")
    dropped = len(raw) - len(head.encode()) - len(tail.encode())
    return head + CLIP_MARKER.format(dropped=dropped) + tail


def text_of(message: dict[str, Any]) -> str:
    """A message as plain text: its content and any tool calls it makes."""
    content = message.get("content")
    text = content if isinstance(content, str) else json.dumps(content or "")
    for call in message.get("tool_calls") or []:
        fn = call["function"]
        text += f"\n-> {fn['name']}({fn['arguments']})"
    return text


def tokens(messages: list[dict[str, Any]]) -> int:
    """A rough count, four bytes a token. Good enough for a threshold."""
    return sum(len(text_of(m).encode()) for m in messages) // 4


def head_end(messages: list[dict[str, Any]]) -> int:
    """Where the task statement ends: past the system prompt and the first
    user message, which compaction never touches."""
    for i, message in enumerate(messages):
        if message["role"] == "user":
            return i + 1
    return 0


def tail_start(messages: list[dict[str, Any]], floor: int, keep_tokens: int) -> int:
    """The start of the longest suffix within `keep_tokens` (and never less
    than the last step) that begins on a whole step. A tool result can't be
    the first message kept: its call would be gone, and providers reject a
    result without its call."""
    start = len(messages)
    size = 0
    for i in range(len(messages) - 1, floor - 1, -1):
        size += tokens([messages[i]])
        if messages[i]["role"] == "tool":
            continue
        if size > keep_tokens and start < len(messages):
            break
        start = i
    return start


def transcript(messages: list[dict[str, Any]], max_result_bytes: int) -> str:
    """The middle of the conversation as text for the summariser, each tool
    result clipped harder still so the summary call stays cheap."""
    lines = []
    for message in messages:
        text = text_of(message)
        if message["role"] == "tool":
            text = clip(text, max_result_bytes)
        lines.append(f"### {message['role']}\n{text}")
    return "\n\n".join(lines)


def compact(ctx: Any) -> None:
    messages = ctx.context_messages
    floor = head_end(messages)
    start = tail_start(
        messages, floor, int(ctx.config.get("keep_recent_tokens", 16_000))
    )
    middle = messages[floor:start]
    # Nothing to fold, or only the last summary: compacting again would pay
    # for a call and break the cache for nothing.
    if not middle or (len(middle) == 1 and SUMMARY_PREFIX in text_of(middle[0])):
        return
    model = ctx.config.get("summary_model") or SUMMARY_MODELS[ctx.provider.name]
    summary_input = transcript(
        middle, int(ctx.config.get("summary_result_bytes", 8_000))
    )
    try:
        response = ctx.llm.completion(
            messages=[
                {"role": "system", "content": SUMMARY_INSTRUCTIONS},
                {"role": "user", "content": summary_input},
            ],
            model=model,
            tools=None,
            purpose="compact",
        )
        summary = response.choices[0].message.content or ""
    except openai.APIError as error:
        # litellm raises openai.APIError subclasses. A failed summary
        # shouldn't fail the turn.
        print(
            f"contextsbane_9000: summary failed, dropping instead: {error}",
            file=sys.stderr,
        )
        summary = ""
    if not summary.strip():
        summary = f"({len(middle)} earlier messages were dropped without a summary.)"
    # The summary goes in as user text: every provider accepts it there, and
    # it reads as context handed to the agent rather than something it said.
    ctx.context_messages = [
        *messages[:floor],
        {"role": "user", "content": SUMMARY_PREFIX + summary},
        *messages[start:],
    ]
    # ctx.state is whatever this driver left last turn, and None before that.
    state = ctx.state or {}
    count = state.get("compactions", 0) + 1
    ctx.state = {**state, "compactions": count}
    # A copy of each summary for reading after the run, in the trial's logs.
    path = Path(ctx.dirs.state) / "contextsbane_9000" / f"summary_{count:02d}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(summary_input + "\n\n---\n\n" + summary)


def run(ctx: Any) -> Any:
    max_result_bytes = int(ctx.config.get("max_result_bytes", 20_000))
    for message in ctx.context_messages:
        if message["role"] == "tool" and isinstance(message.get("content"), str):
            message["content"] = clip(message["content"], max_result_bytes)
    if tokens(ctx.context_messages) > int(ctx.config.get("compact_at_tokens", 64_000)):
        compact(ctx)
    return ctx.llm.completion()
