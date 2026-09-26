import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

from pydantic_ai import Agent

from context_cup_pydantic import finish


def load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


here = Path(__file__).parent
driver = load("base_pydantic_driver", here / "driver.py")
# The engine's own fake Responses endpoint and turn builder.
engine = load(
    "pydantic_engine_cases",
    here.parents[1] / "engines/pydantic/tests/test_pydantic_engine.py",
)


def test_clip_leaves_small_and_already_clipped_results_alone() -> None:
    assert driver.clip("short", 10) == "short"
    clipped = driver.clip("é" * 10, 5)
    assert clipped.startswith("éé") and "15 bytes removed" in clipped
    assert driver.clip(clipped, 5) == clipped


def test_the_agent_clips_oversized_tool_results_before_the_model_sees_them(
    tmp_path: Path,
) -> None:
    replies = [
        engine.body([engine.call("c1")], "r1"),
        engine.body([engine.done("ok")], "r2"),
    ]
    sent: list[tuple[str, dict[str, Any]]] = []
    ctx = engine.ctx_for(tmp_path, engine.OPENING, replies, sent)
    ctx.config = {"max_bytes": 20}
    agent = driver.run(ctx)
    assert isinstance(agent, Agent)
    finish(ctx, agent)

    items = [
        *engine.OPENING,
        engine.call("c1"),
        {"type": "function_call_output", "call_id": "c1", "output": "x" * 50},
    ]
    ctx = engine.ctx_for(
        tmp_path, items, replies, sent, first=False, state=ctx.state, index=2
    )
    ctx.config = {"max_bytes": 20}
    finish(ctx, driver.run(ctx))
    outputs = [
        i["output"]
        for i in sent[-1][1]["input"]
        if i.get("type") == "function_call_output"
    ]
    assert outputs == ["x" * 20 + "\n\n[truncated by base_pydantic: 30 bytes removed]"]
    assert "x" * 21 not in json.dumps(sent[-1][1]["input"])
