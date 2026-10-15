import importlib.util
from pathlib import Path

from context_cup_protocol.view import Message, ToolCall

spec = importlib.util.spec_from_file_location(
    "observation_masking_driver", Path(__file__).parent / "driver.py"
)
assert spec and spec.loader
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


def turn(n: int, calls: int = 1) -> list[Message]:
    """One assistant turn making `calls` parallel tool calls, and the results."""
    ids = [f"c{n}_{i}" for i in range(calls)]
    return [
        Message(role="assistant", tool_calls=[ToolCall(id=i, name="f") for i in ids]),
        *[Message(role="tool", tool_call_id=i, text=f"out {i}") for i in ids],
    ]


def test_mask_counts_lines_and_is_idempotent():
    once = driver.mask("a\nb\nc")
    assert once == "Old environment output: (3 lines omitted)"
    assert driver.mask(once) == once


def test_only_turns_before_the_window_are_masked():
    messages = [Message(role="user", text="task"), *turn(1), *turn(2, calls=2)]
    messages += [Message(role="assistant", text="done?"), *turn(3)]
    assert driver.masked_call_ids(messages, window=2) == {"c1_0"}
    # Parallel calls count as one turn: masking one more turn takes both.
    assert driver.masked_call_ids(messages, window=1) == {"c1_0", "c2_0", "c2_1"}
    assert driver.masked_call_ids(messages, window=3) == set()
    assert len(driver.masked_call_ids(messages, window=0)) == 4


def test_masking_an_openai_payload_touches_only_old_results():
    from context_cup_protocol.view import view, write

    def step(n: int) -> list[dict]:
        return [
            {"type": "reasoning", "id": f"rs{n}", "summary": []},
            {
                "type": "function_call",
                "call_id": f"c{n}",
                "name": "f",
                "arguments": "{}",
            },
            {
                "type": "function_call_output",
                "call_id": f"c{n}",
                "output": f"line\n{n}",
            },
        ]

    payload = {
        "model": "m",
        "instructions": "sys",
        "input": [{"role": "user", "content": "task"}, *step(1), *step(2)],
    }
    conversation = view("openai", payload)
    driver.mask_old(conversation, window=1)
    out = write("openai", payload, conversation)
    assert out["input"][3]["output"] == "Old environment output: (2 lines omitted)"
    assert out["input"][6]["output"] == "line\n2"
    # Everything but the masked result is exactly as it was.
    assert [i for k, i in enumerate(out["input"]) if k != 3] == [
        i for k, i in enumerate(payload["input"]) if k != 3
    ]
    # Next turn the masked result reads the same, so the prefix stays cached.
    again = view("openai", out)
    driver.mask_old(again, window=1)
    assert write("openai", out, again) == out
