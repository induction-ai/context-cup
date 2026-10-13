import importlib.util
from pathlib import Path
from types import SimpleNamespace

import ai
from ai.types.messages import ToolCallPart, ToolResultPart

spec = importlib.util.spec_from_file_location(
    "base_aisdk_python_driver", Path(__file__).parent / "driver.py"
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
        def generate(self):
            sent["messages"] = ctx.context_messages
            return "message"

    long = "x" * 50
    ctx = SimpleNamespace(
        context_messages=[
            ai.system_message("be brief"),
            ai.user_message(long),
            ai.assistant_message(
                ToolCallPart(tool_call_id="c1", tool_name="read", tool_args="{}"),
                ToolCallPart(tool_call_id="c2", tool_name="read", tool_args="{}"),
            ),
            ai.tool_message(
                ai.tool_result_part("c1", result=long, tool_name="read"),
                ai.tool_result_part("c2", result="small", tool_name="read"),
            ),
        ],
        config={"max_bytes": 20},
        llm=LLM(),
    )
    assert driver.run(ctx) == "message"
    messages = sent["messages"]
    assert messages[1].parts[0].text == long, "user text is not a tool result"
    results = [p for p in messages[3].parts if isinstance(p, ToolResultPart)]
    assert [r.tool_call_id for r in results] == ["c1", "c2"], (
        "every call keeps its result"
    )
    assert results[0].result == "x" * 20 + (
        "\n\n[truncated by base_aisdk_python: 30 bytes removed]"
    )
    assert results[1].result == "small"
