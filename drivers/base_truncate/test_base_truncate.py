import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "base_truncate_driver", Path(__file__).parent / "driver.py"
)
assert spec and spec.loader
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


def test_clips_once_and_leaves_a_clipped_result_alone_on_later_turns():
    once = driver.clip("y" * 50, 10)
    assert once.startswith("y" * 10) and "40 bytes removed" in once
    # Next turn the clipped text comes back from context_payload; its marker
    # takes it over the limit again, but it must stay exactly as it was.
    assert driver.clip(once, 10) == once


def test_short_results_pass_through():
    assert driver.clip("short", 10) == "short"
