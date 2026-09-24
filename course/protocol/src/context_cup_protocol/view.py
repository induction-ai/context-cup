"""A provider-neutral view of a native payload, and the way back.

`view(provider, payload)` reads a request body into a `Conversation`:
system text, messages (user, assistant, tool), and function tools.
Whatever the view does not model (reasoning items, thinking blocks, thought
parts, images, provider-only keys) rides along untouched: as `opaque`
fragments on the message it belongs to, or as keys on a native object the
view patches instead of rebuilding.

`write(provider, payload, conversation)` returns a new payload with the
conversation's edits applied. Anything left unedited comes back exactly as
it was, so `write(p, payload, view(p, payload)) == payload`. An edited
message is rebuilt by patching its native form in place: changing one tool
result's text changes that text and nothing else.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field, PrivateAttr

from .models import Payload, Provider
from .providers.base import parse_arguments

Native = dict[str, Any]


class ToolCall(BaseModel):
    id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class Message(BaseModel):
    role: Literal["user", "assistant", "tool"]
    text: str | None = None
    tool_calls: list[ToolCall] = Field(default_factory=list)
    tool_call_id: str | None = None
    """For a tool message: the call it answers."""
    opaque: list[Native] = Field(default_factory=list)
    """Native fragments the view does not model, kept with this message."""

    _unit: int | None = PrivateAttr(default=None)
    _pos: int = PrivateAttr(default=0)
    _snapshot: dict[str, Any] | None = PrivateAttr(default=None)

    def edited(self) -> bool:
        return self._snapshot is None or self.model_dump() != self._snapshot


class Tool(BaseModel):
    name: str
    description: str = ""
    parameters: dict[str, Any] = Field(default_factory=dict)


class Conversation(BaseModel):
    system: str | None = None
    messages: list[Message] = Field(default_factory=list)
    tools: list[Tool] = Field(default_factory=list)

    _system: str | None = PrivateAttr(default=None)
    _tools: list[dict[str, Any]] = PrivateAttr(default_factory=list)


def _seal(message: Message, unit: int, pos: int) -> Message:
    message._unit = unit
    message._pos = pos
    message._snapshot = message.model_dump()
    return message


def _text_parts(
    parts: Any, *, kinds: tuple[str, ...]
) -> tuple[str | None, list[Native]]:
    """Joined text of the text-like parts, and the other parts as opaque."""
    if isinstance(parts, str):
        return parts, []
    texts: list[str] = []
    other: list[Native] = []
    for part in parts or []:
        if (
            isinstance(part, dict)
            and part.get("type") in kinds
            and isinstance(part.get("text"), str)
        ):
            texts.append(part["text"])
        elif isinstance(part, dict):
            other.append(copy.deepcopy(part))
    return ("\n".join(texts) if texts else None), other


def _keep_opaque(fragment: Native, pool: list[Native]) -> bool:
    """Whether the edited message still holds `fragment`; consumes it."""
    for index, candidate in enumerate(pool):
        if candidate == fragment:
            del pool[index]
            return True
    return False


def _patched_text_list(
    blocks: list[Any],
    text: str | None,
    pool: list[Native],
    kinds: tuple[str, ...],
    fresh: Native,
) -> list[Any]:
    """Text blocks collapse to one carrying `text` (based on the first one);
    other blocks stay where they were if the message still holds them."""
    out: list[Any] = []
    placed = False
    for block in blocks:
        if isinstance(block, dict) and block.get("type") in kinds:
            if not placed and text:
                out.append({**block, "text": text})
            placed = True
        elif isinstance(block, dict) and _keep_opaque(block, pool):
            out.append(block)
    if text and not placed:
        out.insert(0, {**fresh, "text": text})
    out.extend(pool)
    return out


def _merge_tools(
    old: list[Any], tools: list[Tool], *, is_function: Any, render: Any
) -> list[Any]:
    """Function tools patched in place by name, removed ones dropped, new
    ones appended; other native tools stay where they were."""
    wanted = {tool.name: tool for tool in tools}
    out: list[Any] = []
    for entry in old:
        if not is_function(entry):
            out.append(entry)
        elif entry.get("name") in wanted:
            out.append(render(entry, wanted.pop(entry["name"])))
    out.extend(render({}, tool) for tool in wanted.values())
    return out


def _call_names(conversation: Conversation) -> dict[str, str]:
    return {
        call.id: call.name
        for message in conversation.messages
        for call in message.tool_calls
    }


class Codec(Protocol):
    list_key: str

    def get_system(self, payload: Payload) -> str | None: ...
    def set_system(self, payload: Payload, text: str | None) -> None: ...
    def get_tools(self, payload: Payload) -> list[Tool]: ...
    def set_tools(self, payload: Payload, tools: list[Tool]) -> None: ...
    def units(self, payload: Payload) -> list[Any]: ...
    def read(self, index: int, unit: Any, before: list[Message]) -> list[Message]: ...
    def build(
        self, original: Any | None, messages: list[Message], names: dict[str, str]
    ) -> list[Native]: ...


# -- OpenAI Responses -------------------------------------------------------

_OPENAI_TEXT = ("output_text", "input_text", "text")


def _openai_assistant_side(item: Native) -> bool:
    kind = item.get("type")
    user_side = kind in (None, "message") and item.get("role") in (
        "user",
        "system",
        "developer",
    )
    return kind != "function_call_output" and not user_side


class OpenAICodec:
    """`instructions`, `input` items, `tools`. One assistant message is a run
    of consecutive assistant-side items: message, function_call, reasoning."""

    list_key = "input"

    def get_system(self, payload: Payload) -> str | None:
        value = payload.get("instructions")
        return value if isinstance(value, str) else None

    def set_system(self, payload: Payload, text: str | None) -> None:
        if text is None:
            payload.pop("instructions", None)
        else:
            payload["instructions"] = text

    def get_tools(self, payload: Payload) -> list[Tool]:
        return [
            Tool(
                name=str(t.get("name")),
                description=str(t.get("description") or ""),
                parameters=t.get("parameters") or {},
            )
            for t in payload.get("tools") or []
            if isinstance(t, dict) and t.get("type") == "function"
        ]

    def set_tools(self, payload: Payload, tools: list[Tool]) -> None:
        payload["tools"] = _merge_tools(
            payload.get("tools") or [],
            tools,
            is_function=lambda t: t.get("type") == "function",
            render=lambda base, tool: {
                "type": "function",
                **base,
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            },
        )

    def units(self, payload: Payload) -> list[Any]:
        units: list[list[Native]] = []
        for item in payload.get("input") or []:
            if not isinstance(item, dict):
                units.append([item])
                continue
            if (
                _openai_assistant_side(item)
                and units
                and all(
                    isinstance(i, dict) and _openai_assistant_side(i) for i in units[-1]
                )
            ):
                units[-1].append(item)
            else:
                units.append([item])
        return units

    def read(self, index: int, unit: Any, before: list[Message]) -> list[Message]:
        first = unit[0]
        if not isinstance(first, dict):
            return []
        if first.get("type") == "function_call_output":
            output = first.get("output")
            text, opaque = _text_parts(output, kinds=_OPENAI_TEXT)
            return [
                Message(
                    role="tool",
                    tool_call_id=str(first.get("call_id") or ""),
                    text=text,
                    opaque=opaque,
                )
            ]
        if not _openai_assistant_side(first):
            text, opaque = _text_parts(first.get("content"), kinds=_OPENAI_TEXT)
            return [Message(role="user", text=text, opaque=opaque)]
        texts: list[str] = []
        calls: list[ToolCall] = []
        opaque_items: list[Native] = []
        for item in unit:
            kind = item.get("type")
            if kind in (None, "message"):
                text, _ = _text_parts(item.get("content"), kinds=_OPENAI_TEXT)
                if text:
                    texts.append(text)
            elif kind == "function_call":
                calls.append(
                    ToolCall(
                        id=str(item.get("call_id") or item.get("id") or ""),
                        name=str(item.get("name") or ""),
                        arguments=parse_arguments(item.get("arguments")),
                    )
                )
            else:
                opaque_items.append(copy.deepcopy(item))
        return [
            Message(
                role="assistant",
                text="\n".join(texts) if texts else None,
                tool_calls=calls,
                opaque=opaque_items,
            )
        ]

    def build(
        self, original: Any | None, messages: list[Message], names: dict[str, str]
    ) -> list[Native]:
        (message,) = messages
        if message.role == "tool":
            base = original[0] if original else {"type": "function_call_output"}
            old = base.get("output")
            output: Any = message.text or ""
            if isinstance(old, list):
                output = _patched_text_list(
                    old,
                    message.text,
                    list(message.opaque),
                    _OPENAI_TEXT,
                    {"type": "input_text"},
                )
            elif message.opaque:
                output = [
                    {"type": "input_text", "text": message.text or ""},
                    *message.opaque,
                ]
            return [{**base, "call_id": message.tool_call_id, "output": output}]
        if message.role == "user":
            base = original[0] if original else {"role": "user"}
            content = base.get("content")
            new: Any
            if isinstance(content, list):
                new = _patched_text_list(
                    content,
                    message.text,
                    list(message.opaque),
                    _OPENAI_TEXT,
                    {"type": "input_text"},
                )
            elif message.opaque:
                new = [
                    {"type": "input_text", "text": message.text or ""},
                    *message.opaque,
                ]
            else:
                new = message.text or ""
            return [{**base, "content": new}]
        return self._build_assistant(original or [], message)

    def _build_assistant(
        self, original: list[Native], message: Message
    ) -> list[Native]:
        pool = list(message.opaque)
        calls = {call.id: call for call in message.tool_calls}
        text_changed = (
            message._snapshot is None or message.text != message._snapshot["text"]
        )
        out: list[Native] = []
        placed = False
        for item in original:
            kind = item.get("type")
            if kind in (None, "message"):
                if not text_changed:
                    out.append(item)
                elif not placed and message.text:
                    content = item.get("content")
                    new = (
                        _patched_text_list(
                            content,
                            message.text,
                            [],
                            _OPENAI_TEXT,
                            {"type": "output_text", "annotations": []},
                        )
                        if isinstance(content, list)
                        else message.text
                    )
                    out.append({**item, "content": new})
                placed = placed or text_changed
            elif kind == "function_call":
                call = calls.pop(str(item.get("call_id") or item.get("id") or ""), None)
                if call is not None:
                    out.append(_openai_call(item, call))
            elif _keep_opaque(item, pool):
                out.append(item)
        if text_changed and not placed and message.text:
            first_call = next(
                (i for i, x in enumerate(out) if x.get("type") == "function_call"),
                len(out),
            )
            out.insert(
                first_call,
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {"type": "output_text", "text": message.text, "annotations": []}
                    ],
                },
            )
        out = pool + out
        out.extend(
            _openai_call({"type": "function_call"}, call) for call in calls.values()
        )
        return out


def _openai_call(base: Native, call: ToolCall) -> Native:
    arguments = base.get("arguments")
    if parse_arguments(arguments) != call.arguments:
        arguments = json.dumps(call.arguments, ensure_ascii=False)
    return {
        **base,
        "call_id": call.id,
        "name": call.name,
        "arguments": arguments or "{}",
    }


# -- Anthropic Messages -----------------------------------------------------

_ANTHROPIC_TEXT = ("text",)


class AnthropicCodec:
    """`system`, `messages` with content blocks, `tools`. A user message
    holding tool_result blocks reads as one tool message per block."""

    list_key = "messages"

    def get_system(self, payload: Payload) -> str | None:
        system = payload.get("system")
        if isinstance(system, list):
            return _text_parts(system, kinds=_ANTHROPIC_TEXT)[0]
        return system if isinstance(system, str) else None

    def set_system(self, payload: Payload, text: str | None) -> None:
        system = payload.get("system")
        if text is None:
            payload.pop("system", None)
        elif isinstance(system, list):
            others = [b for b in system if b.get("type") not in _ANTHROPIC_TEXT]
            payload["system"] = _patched_text_list(
                system, text, others, _ANTHROPIC_TEXT, {"type": "text"}
            )
        else:
            payload["system"] = text

    def get_tools(self, payload: Payload) -> list[Tool]:
        return [
            Tool(
                name=str(t.get("name")),
                description=str(t.get("description") or ""),
                parameters=t.get("input_schema") or {},
            )
            for t in payload.get("tools") or []
            if isinstance(t, dict) and "input_schema" in t
        ]

    def set_tools(self, payload: Payload, tools: list[Tool]) -> None:
        payload["tools"] = _merge_tools(
            payload.get("tools") or [],
            tools,
            is_function=lambda t: "input_schema" in t,
            render=lambda base, tool: {
                **base,
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.parameters,
            },
        )

    def units(self, payload: Payload) -> list[Any]:
        return list(payload.get("messages") or [])

    def read(self, index: int, unit: Any, before: list[Message]) -> list[Message]:
        if not isinstance(unit, dict):
            return []
        content = unit.get("content")
        if unit.get("role") == "assistant":
            texts: list[str] = []
            calls: list[ToolCall] = []
            opaque: list[Native] = []
            for block in content if isinstance(content, list) else []:
                if block.get("type") == "text" and isinstance(block.get("text"), str):
                    texts.append(block["text"])
                elif block.get("type") == "tool_use":
                    calls.append(
                        ToolCall(
                            id=str(block.get("id") or ""),
                            name=str(block.get("name") or ""),
                            arguments=parse_arguments(block.get("input")),
                        )
                    )
                else:
                    opaque.append(copy.deepcopy(block))
            if isinstance(content, str):
                texts.append(content)
            return [
                Message(
                    role="assistant",
                    text="\n".join(texts) if texts else None,
                    tool_calls=calls,
                    opaque=opaque,
                )
            ]
        if not isinstance(content, list):
            return [
                Message(role="user", text=content if isinstance(content, str) else None)
            ]
        messages: list[Message] = []
        user: Message | None = None
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_result":
                text, opaque = _text_parts(block.get("content"), kinds=_ANTHROPIC_TEXT)
                messages.append(
                    Message(
                        role="tool",
                        tool_call_id=str(block.get("tool_use_id") or ""),
                        text=text,
                        opaque=opaque,
                    )
                )
                continue
            if user is None:
                user = Message(role="user")
                messages.append(user)
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                user.text = (
                    block["text"]
                    if user.text is None
                    else f"{user.text}\n{block['text']}"
                )
            else:
                user.opaque.append(copy.deepcopy(block))
        return messages

    def build(
        self, original: Any | None, messages: list[Message], names: dict[str, str]
    ) -> list[Native]:
        if messages[0].role == "assistant":
            (message,) = messages
            return [self._build_assistant(original, message)]
        if original is None:
            blocks: list[Native] = []
            for message in messages:
                if message.role == "tool":
                    blocks.append(_tool_result({"type": "tool_result"}, message))
                else:
                    if message.text:
                        blocks.append({"type": "text", "text": message.text})
                    blocks.extend(message.opaque)
            return [{"role": "user", "content": blocks}]
        content = original.get("content")
        if not isinstance(content, list):
            (message,) = messages
            return [{**original, "content": message.text or ""}]
        tools = {m.tool_call_id: m for m in messages if m.role == "tool"}
        user = next((m for m in messages if m.role == "user"), None)
        pool = list(user.opaque) if user else []
        text_changed = user is not None and (
            user._snapshot is None or user.text != user._snapshot["text"]
        )
        out: list[Any] = []
        placed = False
        for block in content:
            kind = block.get("type") if isinstance(block, dict) else None
            if kind == "tool_result":
                key = str(block.get("tool_use_id") or "")
                answer = tools.pop(key) if key in tools else None
                if answer is not None:
                    out.append(
                        block if not answer.edited() else _tool_result(block, answer)
                    )
            elif kind == "text":
                if user is None:
                    continue
                if not text_changed:
                    out.append(block)
                elif not placed and user.text:
                    out.append({**block, "text": user.text})
                placed = placed or text_changed
            elif _keep_opaque(block, pool):
                out.append(block)
        if user is not None and text_changed and not placed and user.text:
            out.append({"type": "text", "text": user.text})
        out.extend(pool)
        out.extend(_tool_result({"type": "tool_result"}, m) for m in tools.values())
        return [{**original, "content": out}]

    def _build_assistant(self, original: Native | None, message: Message) -> Native:
        blocks = (original or {}).get("content")
        blocks = (
            blocks
            if isinstance(blocks, list)
            else ([{"type": "text", "text": blocks}] if isinstance(blocks, str) else [])
        )
        pool = list(message.opaque)
        calls = {call.id: call for call in message.tool_calls}
        text_changed = (
            message._snapshot is None or message.text != message._snapshot["text"]
        )
        out: list[Native] = []
        placed = False
        for block in blocks:
            kind = block.get("type")
            if kind == "text":
                if not text_changed:
                    out.append(block)
                elif not placed and message.text:
                    out.append({**block, "text": message.text})
                placed = placed or text_changed
            elif kind == "tool_use":
                call = calls.pop(str(block.get("id") or ""), None)
                if call is not None:
                    out.append(
                        {
                            **block,
                            "id": call.id,
                            "name": call.name,
                            "input": call.arguments,
                        }
                    )
            elif _keep_opaque(block, pool):
                out.append(block)
        if text_changed and not placed and message.text:
            first_call = next(
                (i for i, b in enumerate(out) if b.get("type") == "tool_use"), len(out)
            )
            out.insert(first_call, {"type": "text", "text": message.text})
        out = pool + out
        out.extend(
            {"type": "tool_use", "id": c.id, "name": c.name, "input": c.arguments}
            for c in calls.values()
        )
        return {**(original or {"role": "assistant"}), "content": out}


def _tool_result(base: Native, message: Message) -> Native:
    old = base.get("content")
    content: Any = message.text or ""
    if isinstance(old, list):
        content = _patched_text_list(
            old, message.text, list(message.opaque), _ANTHROPIC_TEXT, {"type": "text"}
        )
    elif message.opaque:
        content = [{"type": "text", "text": message.text or ""}, *message.opaque]
    return {**base, "tool_use_id": message.tool_call_id, "content": content}


# -- Gemini generateContent -------------------------------------------------

MINTED_PREFIX = "gemini-call-"


def _gemini_text(part: Any) -> bool:
    return (
        isinstance(part, dict)
        and isinstance(part.get("text"), str)
        and not part.get("thought")
    )


def _gemini_schema_key(declaration: Native) -> str:
    """Where a declaration keeps its schema: `parameters` (an OpenAPI subset)
    if it already does, else `parametersJsonSchema`, the one the adapter
    writes."""
    return "parameters" if "parameters" in declaration else "parametersJsonSchema"


class GeminiCodec:
    """`systemInstruction`, `contents` with parts, `tools` with
    functionDeclarations. Calls without an API id get a minted one, used only
    inside the view; responses go back by name, as the API expects."""

    list_key = "contents"

    def get_system(self, payload: Payload) -> str | None:
        system = payload.get("systemInstruction")
        if not isinstance(system, dict):
            return None
        texts = [p["text"] for p in system.get("parts") or [] if _gemini_text(p)]
        return "\n".join(texts) if texts else None

    def set_system(self, payload: Payload, text: str | None) -> None:
        if text is None:
            payload.pop("systemInstruction", None)
            return
        system = payload.get("systemInstruction")
        base = system if isinstance(system, dict) else {}
        others = [p for p in base.get("parts") or [] if not _gemini_text(p)]
        payload["systemInstruction"] = {**base, "parts": [{"text": text}, *others]}

    def _declarations(self, payload: Payload) -> list[Native]:
        return [
            d
            for entry in payload.get("tools") or []
            if isinstance(entry, dict)
            for d in entry.get("functionDeclarations") or []
        ]

    def get_tools(self, payload: Payload) -> list[Tool]:
        return [
            Tool(
                name=str(d.get("name")),
                description=str(d.get("description") or ""),
                parameters=d.get("parametersJsonSchema") or d.get("parameters") or {},
            )
            for d in self._declarations(payload)
        ]

    def set_tools(self, payload: Payload, tools: list[Tool]) -> None:
        declarations = _merge_tools(
            self._declarations(payload),
            tools,
            is_function=lambda d: True,
            render=lambda base, tool: {
                **base,
                "name": tool.name,
                "description": tool.description,
                _gemini_schema_key(base): tool.parameters,
            },
        )
        entries: list[Any] = []
        placed = False
        for entry in payload.get("tools") or []:
            if isinstance(entry, dict) and "functionDeclarations" in entry:
                if not placed and declarations:
                    entries.append({**entry, "functionDeclarations": declarations})
                placed = True
            else:
                entries.append(entry)
        if not placed and declarations:
            entries.insert(0, {"functionDeclarations": declarations})
        payload["tools"] = entries

    def units(self, payload: Payload) -> list[Any]:
        return list(payload.get("contents") or [])

    def read(self, index: int, unit: Any, before: list[Message]) -> list[Message]:
        if not isinstance(unit, dict):
            return []
        parts = unit.get("parts") or []
        if unit.get("role") == "model":
            texts: list[str] = []
            calls: list[ToolCall] = []
            opaque: list[Native] = []
            for position, part in enumerate(parts):
                call = part.get("functionCall") if isinstance(part, dict) else None
                if isinstance(call, dict):
                    calls.append(
                        ToolCall(
                            id=str(
                                call.get("id") or f"{MINTED_PREFIX}{index}-{position}"
                            ),
                            name=str(call.get("name") or ""),
                            arguments=parse_arguments(call.get("args")),
                        )
                    )
                elif _gemini_text(part):
                    texts.append(part["text"])
                elif isinstance(part, dict):
                    opaque.append(copy.deepcopy(part))
            return [
                Message(
                    role="assistant",
                    text="\n".join(texts) if texts else None,
                    tool_calls=calls,
                    opaque=opaque,
                )
            ]
        previous = next((m for m in reversed(before) if m.role == "assistant"), None)
        pending = list(previous.tool_calls) if previous else []
        messages: list[Message] = []
        user: Message | None = None
        for part in parts:
            if not isinstance(part, dict):
                continue
            response = part.get("functionResponse")
            if isinstance(response, dict):
                call_id = response.get("id")
                if not call_id:
                    match = next(
                        (c for c in pending if c.name == response.get("name")), None
                    )
                    call_id = match.id if match else ""
                pending = [c for c in pending if c.id != call_id]
                result = response.get("response")
                text = (
                    result["result"]
                    if isinstance(result, dict)
                    and isinstance(result.get("result"), str)
                    else json.dumps(result, ensure_ascii=False)
                )
                messages.append(
                    Message(role="tool", tool_call_id=str(call_id), text=text)
                )
                continue
            if user is None:
                user = Message(role="user")
                messages.append(user)
            if _gemini_text(part):
                user.text = (
                    part["text"]
                    if user.text is None
                    else f"{user.text}\n{part['text']}"
                )
            else:
                user.opaque.append(copy.deepcopy(part))
        return messages

    def build(
        self, original: Any | None, messages: list[Message], names: dict[str, str]
    ) -> list[Native]:
        if messages[0].role == "assistant":
            (message,) = messages
            return [self._build_model(original, message)]
        tools = {m.tool_call_id: m for m in messages if m.role == "tool"}
        user = next((m for m in messages if m.role == "user"), None)
        pool = list(user.opaque) if user else []
        text_changed = user is not None and (
            user._snapshot is None or user.text != user._snapshot["text"]
        )
        out: list[Any] = []
        placed = False
        for part in (original or {}).get("parts") or []:
            response = part.get("functionResponse") if isinstance(part, dict) else None
            if isinstance(response, dict):
                call_id = response.get("id")
                answer = (
                    tools.pop(str(call_id))
                    if call_id and str(call_id) in tools
                    else None
                )
                if answer is None and not call_id:
                    answer = next(
                        (
                            m
                            for k, m in tools.items()
                            if names.get(str(k)) == response.get("name")
                        ),
                        None,
                    )
                    if answer is not None:
                        tools.pop(answer.tool_call_id)
                if answer is not None:
                    out.append(
                        part
                        if not answer.edited()
                        else _function_response(part, answer, names)
                    )
            elif _gemini_text(part):
                if user is None:
                    continue
                if not text_changed:
                    out.append(part)
                elif not placed and user.text:
                    out.append({**part, "text": user.text})
                placed = placed or text_changed
            elif _keep_opaque(part, pool):
                out.append(part)
        if user is not None and text_changed and not placed and user.text:
            out.append({"text": user.text})
        out.extend(pool)
        out.extend(_function_response({}, m, names) for m in tools.values())
        return [{**(original or {"role": "user"}), "parts": out}]

    def _build_model(self, original: Native | None, message: Message) -> Native:
        pool = list(message.opaque)
        calls = {call.id: call for call in message.tool_calls}
        text_changed = (
            message._snapshot is None or message.text != message._snapshot["text"]
        )
        out: list[Native] = []
        placed = False
        for position, part in enumerate((original or {}).get("parts") or []):
            call = part.get("functionCall") if isinstance(part, dict) else None
            if isinstance(call, dict):
                key = str(
                    call.get("id") or f"{MINTED_PREFIX}{message._unit}-{position}"
                )
                found = calls.pop(key, None)
                if found is not None:
                    out.append({**part, "functionCall": _gemini_call(call, found)})
            elif _gemini_text(part):
                if not text_changed:
                    out.append(part)
                elif not placed and message.text:
                    out.append({**part, "text": message.text})
                placed = placed or text_changed
            elif _keep_opaque(part, pool):
                out.append(part)
        if text_changed and not placed and message.text:
            first_call = next(
                (i for i, p in enumerate(out) if "functionCall" in p), len(out)
            )
            out.insert(first_call, {"text": message.text})
        out = pool + out
        out.extend({"functionCall": _gemini_call({}, c)} for c in calls.values())
        return {**(original or {"role": "model"}), "parts": out}


def _gemini_call(base: Native, call: ToolCall) -> Native:
    out = {**base, "name": call.name, "args": call.arguments}
    if not call.id.startswith(MINTED_PREFIX):
        out["id"] = call.id
    return out


def _function_response(part: Native, message: Message, names: dict[str, str]) -> Native:
    base = part.get("functionResponse") or {}
    result = base.get("response")
    response = (
        {**result, "result": message.text or ""}
        if isinstance(result, dict)
        else {"result": message.text or ""}
    )
    call_id = message.tool_call_id or ""
    new: Native = {
        **base,
        "name": base.get("name") or names.get(call_id, ""),
        "response": response,
    }
    if call_id and not call_id.startswith(MINTED_PREFIX):
        new["id"] = call_id
    return {**part, "functionResponse": new}


# -- entry points -------------------------------------------------------------

CODECS: dict[Provider, Codec] = {
    "openai": OpenAICodec(),
    "anthropic": AnthropicCodec(),
    "gemini": GeminiCodec(),
}


def view(provider: Provider, payload: Payload) -> Conversation:
    """The payload as a provider-neutral conversation."""
    codec = CODECS[provider]
    conversation = Conversation(
        system=codec.get_system(payload), tools=codec.get_tools(payload)
    )
    for index, unit in enumerate(codec.units(payload)):
        read = codec.read(index, unit, conversation.messages)
        conversation.messages.extend(_seal(m, index, pos) for pos, m in enumerate(read))
    conversation._system = conversation.system
    conversation._tools = [t.model_dump() for t in conversation.tools]
    return conversation


@dataclass
class _Run:
    unit: int | None
    messages: list[Message]


def _runs(messages: list[Message]) -> list[_Run]:
    """Consecutive messages from one native unit, in conversation order. A
    unit that shows up again later is new material there."""
    runs: list[_Run] = []
    used: set[int] = set()
    for message in messages:
        unit = message._unit
        if unit is not None and runs and runs[-1].unit == unit:
            runs[-1].messages.append(message)
            continue
        if unit is not None and unit in used:
            unit = None
        if unit is not None:
            used.add(unit)
        runs.append(_Run(unit, [message]))
    return runs


def write(provider: Provider, payload: Payload, conversation: Conversation) -> Payload:
    """A new payload carrying the conversation's edits; `payload` is not
    modified."""
    codec = CODECS[provider]
    out = copy.deepcopy(payload)
    if conversation.system != conversation._system:
        codec.set_system(out, conversation.system)
    if [t.model_dump() for t in conversation.tools] != conversation._tools:
        codec.set_tools(out, conversation.tools)
    units = codec.units(payload)
    original_counts = _original_counts(codec, payload)
    names = _call_names(conversation)
    rebuilt: list[Any] = []
    for run in _runs(conversation.messages):
        original = copy.deepcopy(units[run.unit]) if run.unit is not None else None
        whole = run.unit is not None and [m._pos for m in run.messages] == list(
            range(original_counts[run.unit])
        )
        if whole and not any(m.edited() for m in run.messages):
            rebuilt.extend(original if isinstance(original, list) else [original])
            continue
        if run.unit is None:
            for message in run.messages:
                rebuilt.extend(codec.build(None, [message], names))
        else:
            rebuilt.extend(codec.build(original, run.messages, names))
    if rebuilt or codec.list_key in out:
        out[codec.list_key] = rebuilt
    return out


def _original_counts(codec: Codec, payload: Payload) -> dict[int, int]:
    counts: dict[int, int] = {}
    seen: list[Message] = []
    for index, unit in enumerate(codec.units(payload)):
        read = codec.read(index, unit, seen)
        seen.extend(read)
        counts[index] = len(read)
    return counts
