"""Small helpers shared by the MCP-backed environments."""

from __future__ import annotations

import json
from typing import Any


def result_text(result: Any) -> str:
    """Flatten an MCP CallToolResult into text."""
    parts: list[str] = []
    for item in getattr(result, "content", None) or []:
        text = getattr(item, "text", None)
        if text is not None:
            parts.append(str(text))
            continue
        try:
            parts.append(json.dumps(item.model_dump(mode="json"), ensure_ascii=False))
        except Exception:  # noqa: BLE001 - best effort rendering of odd content
            parts.append(str(item))
    if not parts:
        structured = getattr(result, "structuredContent", None)
        if structured is not None:
            parts.append(json.dumps(structured, ensure_ascii=False, sort_keys=True))
    return "\n".join(parts)


def mcp_tool_to_function_tool(tool: Any, *, name: str | None = None) -> dict[str, Any]:
    """An MCP tool listing as an OpenAI function schema, the neutral tool
    shape the provider adapters convert from."""
    schema = getattr(tool, "inputSchema", None) or {"type": "object", "properties": {}}
    return {
        "type": "function",
        "function": {
            "name": name or tool.name,
            "description": getattr(tool, "description", None) or "",
            "parameters": schema,
        },
    }
