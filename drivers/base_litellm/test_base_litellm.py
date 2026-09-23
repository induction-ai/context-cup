import importlib.util
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location(
    "base_litellm_driver", Path(__file__).parent / "driver.py"
)
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


def call(i, name="lookup"):
    return {
        "id": f"c{i}",
        "type": "function",
        "function": {"name": name, "arguments": "{}"},
    }


def test_orphaned_halves_of_a_tool_pair_are_dropped():
    messages = [
        {
            "role": "tool",
            "tool_call_id": "c0",
            "content": "result whose call was trimmed away",
        },
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": None, "tool_calls": [call(1), call(2)]},
        {"role": "tool", "tool_call_id": "c1", "content": "answered"},
    ]
    kept = driver.keep_tool_pairs(messages)
    assert [m["role"] for m in kept] == ["user", "assistant", "tool"]
    assert [c["id"] for c in kept[1]["tool_calls"]] == ["c1"]


def test_a_budget_forces_trimming_and_the_call_still_goes_out():
    sent = {}

    class LLM:
        def completion(self):
            sent["messages"] = ctx.context_messages
            return "response"

    long = "word " * 4000
    ctx = SimpleNamespace(
        context_messages=[
            {"role": "system", "content": "be brief"},
            {"role": "user", "content": long},
            {"role": "assistant", "content": long},
            {"role": "user", "content": "the question"},
        ],
        target=SimpleNamespace(model="gpt-5.5"),
        config={"max_tokens": 500},
        llm=LLM(),
    )
    assert driver.run(ctx) == "response"
    assert sent["messages"][0]["role"] == "system"
    assert sent["messages"][-1]["content"] == "the question"
    assert sum(len(m["content"] or "") for m in sent["messages"]) < len(long)
