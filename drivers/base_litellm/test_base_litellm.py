import importlib.util
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location(
    "base_litellm_driver", Path(__file__).parent / "driver.py"
)
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


def test_clip_leaves_small_and_already_clipped_results_alone():
    assert driver.clip("short", 10) == "short"
    clipped = driver.clip("é" * 10, 5)
    assert clipped.startswith("éé") and "15 bytes removed" in clipped
    assert driver.clip(clipped, 5) == clipped


def test_only_oversized_tool_results_are_clipped_and_the_call_goes_out():
    sent = {}

    class LLM:
        def completion(self):
            sent["messages"] = ctx.context_messages
            return "response"

    long = "x" * 50
    ctx = SimpleNamespace(
        context_messages=[
            {"role": "system", "content": "be brief"},
            {"role": "user", "content": long},
            {"role": "assistant", "content": None, "tool_calls": []},
            {"role": "tool", "tool_call_id": "c1", "content": long},
            {"role": "tool", "tool_call_id": "c2", "content": "small"},
        ],
        config={"max_bytes": 20},
        llm=LLM(),
    )
    assert driver.run(ctx) == "response"
    messages = sent["messages"]
    assert messages[1]["content"] == long, "user text is not a tool result"
    assert messages[3]["content"] == "x" * 20 + (
        "\n\n[truncated by base_litellm: 30 bytes removed]"
    )
    assert messages[4]["content"] == "small"
