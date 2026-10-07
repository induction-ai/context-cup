import importlib.util
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location(
    "contextsbane_9000_driver", Path(__file__).parent / "driver.py"
)
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


def step(n: int, result: str) -> list[dict]:
    """One assistant tool call and its result."""
    call = {
        "id": f"c{n}",
        "type": "function",
        "function": {"name": "f", "arguments": "{}"},
    }
    return [
        {"role": "assistant", "content": None, "tool_calls": [call]},
        {"role": "tool", "tool_call_id": f"c{n}", "content": result},
    ]


class LLM:
    def __init__(self, summary: str = "SUMMARY") -> None:
        self.summary = summary
        self.calls: list[dict] = []

    def completion(self, messages=None, **kwargs):
        self.calls.append({"messages": messages, **kwargs})
        message = SimpleNamespace(content=self.summary)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def context(messages: list[dict], tmp_path: Path, **config) -> SimpleNamespace:
    return SimpleNamespace(
        context_messages=messages,
        config=config,
        state=None,
        llm=LLM(),
        provider=SimpleNamespace(name="openai"),
        dirs=SimpleNamespace(state=str(tmp_path)),
    )


def test_clip_keeps_head_and_tail_and_is_idempotent():
    text = "a" * 60 + "b" * 40
    clipped = driver.clip(text, 40)
    assert clipped.startswith("a" * 30) and clipped.endswith("b" * 10)
    assert "60 bytes cut" in clipped
    assert driver.clip(clipped, 40) == clipped
    assert driver.clip("short", 40) == "short"


def test_tail_starts_on_a_whole_step():
    messages = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "task"},
        *step(1, "x" * 400),
        *step(2, "y" * 400),
        *step(3, "z" * 400),
    ]
    floor = driver.head_end(messages)
    assert floor == 2
    start = driver.tail_start(messages, floor, keep_tokens=150)
    assert start == 6, "only the last step fits"
    assert messages[start]["role"] == "assistant"
    # The last step is kept even when it alone is over budget.
    assert driver.tail_start(messages, floor, keep_tokens=1) == 6


def test_under_the_threshold_nothing_but_clipping_happens(tmp_path):
    messages = [{"role": "user", "content": "task"}, *step(1, "x" * 100)]
    ctx = context(messages, tmp_path, max_result_bytes=40, compact_at_tokens=10_000)
    driver.run(ctx)
    assert len(ctx.context_messages) == 3
    assert "bytes cut" in ctx.context_messages[2]["content"]
    assert len(ctx.llm.calls) == 1 and ctx.llm.calls[0]["messages"] is None


def test_compaction_folds_the_middle_into_one_summary(tmp_path):
    messages = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "task"},
        *step(1, "x" * 400),
        *step(2, "y" * 400),
        {"role": "user", "content": "and then?"},
        *step(3, "z" * 400),
    ]
    ctx = context(messages, tmp_path, compact_at_tokens=100, keep_recent_tokens=150)
    driver.run(ctx)
    summary_call, _turn_call = ctx.llm.calls
    assert summary_call["purpose"] == "compact"
    assert summary_call["model"] == "gpt-6-luna" and summary_call["tools"] is None
    roles = [m["role"] for m in ctx.context_messages]
    assert roles == ["system", "user", "user", "user", "assistant", "tool"]
    assert ctx.context_messages[2]["content"] == driver.SUMMARY_PREFIX + "SUMMARY"
    assert ctx.context_messages[3]["content"] == "and then?"
    assert ctx.context_messages[5]["content"] == "z" * 400
    assert ctx.state["compactions"] == 1
    assert (tmp_path / "contextsbane_9000" / "summary_01.md").exists()

    # Next turn: still over, but only the summary is left to fold.
    driver.run(ctx)
    assert [c.get("purpose") for c in ctx.llm.calls] == ["compact", None, None]
