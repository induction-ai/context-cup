"""Clip oversized tool output before it enters the thread.

The full text is saved beside the turns so a driver that wants it can read it
back; the note in the thread says where. Paging tools over saved output are a
driver concern.
"""

from __future__ import annotations

from pathlib import Path

CLIPPED_DIR_NAME = "clipped_tool_outputs"


def clip_tool_output(
    text: str, *, max_chars: int, agent_dir: Path, tool_call_id: str
) -> str:
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    save_dir = agent_dir / CLIPPED_DIR_NAME
    save_dir.mkdir(parents=True, exist_ok=True)
    safe_id = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in tool_call_id)
    save_path = save_dir / f"{safe_id}.txt"
    save_path.write_text(text, encoding="utf-8")
    return text[:max_chars] + (
        f"\n\n[Tool output clipped: showing the first {max_chars} of {len(text)} "
        f"characters. The full output was saved to {save_path}.]"
    )
