"""Toolathlon's overlong tool output handling.

A tool result longer than the limit is cut, the full text is saved under a
short id, and the model is told the id. Four environment tools let it search
or page through the saved text without flooding its context again. The
behaviour and wording follow upstream Toolathlon's overlong output manager,
so a driver sees what a Toolathlon agent would.
"""

from __future__ import annotations

import json
import re
import signal
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

OVERLONG_DIR_NAME = ".overlong_tool_outputs"
SEARCH_PAGE_SIZE = 10
MAX_SEARCH_PAGE_SIZE = 50
VIEW_PAGE_SIZE = 10_000
MAX_VIEW_PAGE_SIZE = 100_000
CONTEXT_SIZE = 1_000
"""Characters of context around each search match."""
ACTIONS = ("next_page", "prev_page", "jump_to_page", "first_page", "last_page")
MAX_MATCHES = 1_000
"""Matches a search keeps; the model's pattern could otherwise match at every
position of a multi-megabyte output."""
SEARCH_TIMEOUT_SEC = 10.0
"""How long a search's regex may run before it is abandoned."""
SHORTUUID_RE = re.compile(r"[0-9a-f]{32}")

TruncateMode = Literal["on", "off", "no_json"]


def is_json(text: str) -> bool:
    try:
        json.loads(text)
    except ValueError:
        return False
    return True


def _pages(total: int, size: int) -> int:
    return (total + size - 1) // size if total > 0 else 1


def _as_int(value: Any, default: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise TypeError(f"expected an integer, got {value!r}")
    return int(value)


def _target_page(action: str, current: int, total_pages: int, target: Any) -> int | str:
    """The page an action lands on, or an error message."""
    if action == "next_page":
        return min(current + 1, total_pages)
    if action == "prev_page":
        return max(current - 1, 1)
    if action == "first_page":
        return 1
    if action == "last_page":
        return total_pages
    if action == "jump_to_page":
        if target is None:
            return "Error: target_page parameter is required for jump_to_page action"
        page = _as_int(target, 1)
        if page < 1 or page > total_pages:
            return f"Error: target_page {page} must be between 1 and {total_pages}"
        return page
    return f"Error: Invalid action '{action}'. Valid actions: {', '.join(ACTIONS)}"


def _navigation(page: int, total_pages: int) -> str:
    moves = []
    if page > 1:
        moves.append("prev_page")
    if page < total_pages:
        moves.append("next_page")
    moves.extend(["first_page", "last_page", "jump_to_page"])
    return ", ".join(moves)


class _SearchTimeout(Exception):
    pass


@contextmanager
def _time_limit(seconds: float) -> Iterator[None]:
    """Raise _SearchTimeout in the block after `seconds`. CPython's regex
    engine checks for signals while it matches, so this stops a pattern that
    backtracks without end. Signals only reach the main thread; elsewhere
    the block runs unlimited."""
    if threading.current_thread() is not threading.main_thread():
        yield
        return

    def expire(signum: int, frame: object) -> None:
        raise _SearchTimeout

    previous = signal.signal(signal.SIGALRM, expire)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


@dataclass
class _SearchSession:
    shortuuid: str
    pattern: str
    matches: list[tuple[int, int]]
    """Start and end of each match; the text around one is cut when its page
    is shown."""
    capped: bool
    page_size: int
    context_size: int
    content_length: int
    page: int = 1


@dataclass
class _ViewSession:
    shortuuid: str
    content_length: int
    page_size: int
    page: int = 1


@dataclass
class OverlongOutputs:
    """Saved overlong outputs for one trial, and the tools that read them."""

    save_dir: Path
    max_chars: int = 100_000
    mode: TruncateMode = "on"
    _searches: dict[str, _SearchSession] = field(default_factory=dict)
    _views: dict[str, _ViewSession] = field(default_factory=dict)

    # -- clipping -----------------------------------------------------------

    def clip(self, text: str) -> str:
        """The text as the model sees it: whole, or cut with a note naming
        the saved copy."""
        if self.mode == "off" or self.max_chars <= 0 or len(text) <= self.max_chars:
            return text
        if self.mode == "no_json" and is_json(text):
            return text
        shortuuid = uuid.uuid4().hex
        self.save_dir.mkdir(parents=True, exist_ok=True)
        path = self.save_dir / f"{shortuuid}.json"
        path.write_text(text, encoding="utf-8")
        return text[: self.max_chars] + (
            f" ...\n\n(The output of the tool call (shortuuid identifier: {shortuuid}) "
            f"is too long! Only the first {self.max_chars} characters are shown "
            f"here. The original output length is {len(text)} characters. The full "
            f"output has been saved to the file {path}. Please check this file "
            "carefully, as it may be very long!)"
        )

    # -- the tools ----------------------------------------------------------

    def handles(self, name: str) -> bool:
        return name in _HANDLERS

    def call(self, name: str, arguments: dict[str, Any]) -> str:
        try:
            return _HANDLERS[name](self, arguments)
        except Exception as exc:  # noqa: BLE001 - the model gets the message
            return f"Local tool error:\n{type(exc).__name__}: {exc}"

    def _read(self, shortuuid: str) -> str | None:
        # The id comes from the model: only a name clip() could have made,
        # never a path out of save_dir.
        if not SHORTUUID_RE.fullmatch(shortuuid):
            return None
        path = self.save_dir / f"{shortuuid}.json"
        if not path.exists():
            return None
        return path.read_text(encoding="utf-8")

    def _render_matches(
        self, session: _SearchSession, content: str, start: int, count: int
    ) -> str:
        out = ""
        half = session.context_size // 2
        spans = session.matches[start : start + count]
        for i, (begin, end) in enumerate(spans):
            line = content.count("\n", 0, begin) + 1
            out += (
                f"Match {start + i + 1} (Line ~{line}, "
                f"Pos {begin}-{end}):\n" + "-" * 60 + "\n"
            )
            context = (
                content[max(0, begin - half) : begin]
                + f">>>{content[begin:end]}<<<"
                + content[end : end + half]
            )
            if len(context) > session.context_size * 2:
                context = context[: session.context_size * 2] + "...[truncated]"
            out += context + "\n\n"
        return out

    def search(self, arguments: dict[str, Any]) -> str:
        shortuuid = str(arguments.get("shortuuid", "")).strip()
        pattern = str(arguments.get("pattern", "")).strip()
        page_size = _as_int(arguments.get("page_size"), SEARCH_PAGE_SIZE)
        context_size = _as_int(arguments.get("context_size"), CONTEXT_SIZE)
        if not shortuuid:
            return "Error: shortuuid parameter is required"
        if not pattern:
            return "Error: pattern parameter is required"
        if not 1 <= page_size <= MAX_SEARCH_PAGE_SIZE:
            return f"Error: page_size must be between 1 and {MAX_SEARCH_PAGE_SIZE}"
        content = self._read(shortuuid)
        if content is None:
            return f"Error: No overlong tool output found for shortuuid: {shortuuid}"
        try:
            regex = re.compile(pattern, re.IGNORECASE | re.MULTILINE | re.DOTALL)
        except re.error as exc:
            return f"Error: Invalid regex pattern: {exc}"
        matches: list[tuple[int, int]] = []
        capped = False
        try:
            with _time_limit(SEARCH_TIMEOUT_SEC):
                for found in regex.finditer(content):
                    if found.end() == found.start():
                        continue  # an empty match shows nothing
                    if len(matches) == MAX_MATCHES:
                        capped = True
                        break
                    matches.append(found.span())
        except _SearchTimeout:
            return (
                f"Error: the search for '{pattern}' took longer than "
                f"{SEARCH_TIMEOUT_SEC:g} seconds; use a simpler pattern"
            )
        if not matches:
            return (
                f"No matches found for pattern '{pattern}' in shortuuid: {shortuuid}\n"
                f"File size: {len(content)} characters"
            )
        session_id = uuid.uuid4().hex[:8]
        session = _SearchSession(
            shortuuid, pattern, matches, capped, page_size, context_size, len(content)
        )
        self._searches[session_id] = session
        total_pages = _pages(len(matches), page_size)
        return (
            f"Search Results in {shortuuid} (Page 1/{total_pages})\n"
            f"Pattern: '{pattern}' | Total matches: {_total(session)} | "
            f"File size: {len(content)} chars\n"
            f"Search Session ID: {session_id}\n"
            + "=" * 80
            + "\n\n"
            + self._render_matches(session, content, 0, page_size)
            + f"Use search_session_id '{session_id}' with search_navigate tool for pagination\n"
            + f"Available commands: {', '.join(ACTIONS)}"
        )

    def search_navigate(self, arguments: dict[str, Any]) -> str:
        session_id = str(arguments.get("search_session_id", "")).strip()
        action = str(arguments.get("action", "next_page")).strip().lower()
        if not session_id:
            return "Error: search_session_id parameter is required"
        session = self._searches.get(session_id)
        if session is None:
            return f"Error: Invalid or expired search session ID: {session_id}"
        total_pages = _pages(len(session.matches), session.page_size)
        page = _target_page(
            action, session.page, total_pages, arguments.get("target_page")
        )
        if isinstance(page, str):
            return page
        content = self._read(session.shortuuid)
        if content is None:
            return f"Error: No overlong tool output found for shortuuid: {session.shortuuid}"
        session.page = page
        start = (page - 1) * session.page_size
        return (
            f"Search Results in {session.shortuuid} (Page {page}/{total_pages})\n"
            f"Pattern: '{session.pattern}' | Total matches: {_total(session)} | "
            f"File size: {session.content_length} chars\n"
            f"Search Session ID: {session_id}\n"
            + "=" * 80
            + "\n\n"
            + self._render_matches(session, content, start, session.page_size)
            + f"Available navigation: {_navigation(page, total_pages)}\n"
            + f"Use search_session_id '{session_id}' to continue navigation"
        )

    def view(self, arguments: dict[str, Any]) -> str:
        shortuuid = str(arguments.get("shortuuid", "")).strip()
        page_size = _as_int(arguments.get("page_size"), VIEW_PAGE_SIZE)
        if not shortuuid:
            return "Error: shortuuid parameter is required"
        if not 1 <= page_size <= MAX_VIEW_PAGE_SIZE:
            return f"Error: page_size must be between 1 and {MAX_VIEW_PAGE_SIZE}"
        content = self._read(shortuuid)
        if content is None:
            return f"Error: No overlong tool output found for shortuuid: {shortuuid}"
        total = len(content)
        total_pages = _pages(total, page_size)
        session_id = uuid.uuid4().hex[:8]
        self._views[session_id] = _ViewSession(shortuuid, total, page_size)
        end = min(page_size, total)
        out = (
            f"Viewing {shortuuid} (Page 1/{total_pages})\n"
            f"Characters 0-{end} of {total} | Lines ~1-{content.count(chr(10), 0, end) + 1}\n"
            f"View Session ID: {session_id}\n" + "=" * 80 + "\n\n" + content[:end]
        )
        if end < total:
            out += (
                f"\n\n[Page 1 of {total_pages} - {total - end} more characters available]\n"
                f"Use view_session_id '{session_id}' with view_navigate tool for pagination\n"
                f"Available commands: {', '.join(ACTIONS)}"
            )
        else:
            out += f"\n\n[End of file - {total} characters total]"
        return out

    def view_navigate(self, arguments: dict[str, Any]) -> str:
        session_id = str(arguments.get("view_session_id", "")).strip()
        action = str(arguments.get("action", "next_page")).strip().lower()
        if not session_id:
            return "Error: view_session_id parameter is required"
        session = self._views.get(session_id)
        if session is None:
            return f"Error: Invalid or expired view session ID: {session_id}"
        total = session.content_length
        total_pages = _pages(total, session.page_size)
        page = _target_page(
            action, session.page, total_pages, arguments.get("target_page")
        )
        if isinstance(page, str):
            return page
        session.page = page
        content = self._read(session.shortuuid)
        if content is None:
            return f"Error: No overlong tool output found for shortuuid: {session.shortuuid}"
        start = (page - 1) * session.page_size
        end = min(start + session.page_size, total)
        out = (
            f"Viewing {session.shortuuid} (Page {page}/{total_pages})\n"
            f"Characters {start}-{end} of {total} | "
            f"Lines ~{content.count(chr(10), 0, start) + 1}-{content.count(chr(10), 0, end) + 1}\n"
            f"View Session ID: {session_id}\n" + "=" * 80 + "\n\n" + content[start:end]
        )
        if end < total:
            out += f"\n\n[Page {page} of {total_pages} - {total - end} more characters available]\n"
        else:
            out += f"\n\n[End of file reached - {total} characters total]\n"
        return (
            out
            + f"Available navigation: {_navigation(page, total_pages)}\n"
            + f"Use view_session_id '{session_id}' to continue navigation"
        )


def _total(session: _SearchSession) -> str:
    if session.capped:
        return f"{len(session.matches)}+ (only the first {MAX_MATCHES} are kept)"
    return str(len(session.matches))


_HANDLERS = {
    "local-search_overlong_tooloutput": OverlongOutputs.search,
    "local-search_overlong_tooloutput_navigate": OverlongOutputs.search_navigate,
    "local-view_overlong_tooloutput": OverlongOutputs.view,
    "local-view_overlong_tooloutput_navigate": OverlongOutputs.view_navigate,
}


def _navigate_schema(id_field: str, id_description: str) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            id_field: {"type": "string", "description": id_description},
            "action": {
                "type": "string",
                "description": "Navigation action to perform",
                "enum": list(ACTIONS),
            },
            "target_page": {
                "type": "integer",
                "description": "Target page number (required for jump_to_page action)",
                "minimum": 1,
            },
        },
        "required": [id_field],
        "additionalProperties": False,
    }


def _function(
    name: str, description: str, parameters: dict[str, Any]
) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters,
        },
    }


SHORTUUID = {
    "type": "string",
    "description": "The shortuuid identifier for the overlong tool output",
}

OVERLONG_TOOLS: list[dict[str, Any]] = [
    _function(
        "local-search_overlong_tooloutput",
        "Search within overlong tool output content using regex patterns and "
        "return first page with session ID",
        {
            "type": "object",
            "properties": {
                "shortuuid": SHORTUUID,
                "pattern": {
                    "type": "string",
                    "description": "The regex pattern to search for in the content",
                },
                "page_size": {
                    "type": "integer",
                    "description": "Number of matches per page (default: 10, max: 50)",
                    "minimum": 1,
                    "maximum": MAX_SEARCH_PAGE_SIZE,
                },
                "context_size": {
                    "type": "integer",
                    "description": "Characters of context around each match (default: 1000)",
                    "minimum": 100,
                    "maximum": 5000,
                },
            },
            "required": ["shortuuid", "pattern"],
            "additionalProperties": False,
        },
    ),
    _function(
        "local-search_overlong_tooloutput_navigate",
        "Navigate through search results using search session ID",
        _navigate_schema(
            "search_session_id",
            "The search session ID returned from search_overlong_tool",
        ),
    ),
    _function(
        "local-view_overlong_tooloutput",
        "View overlong tool output content with pagination and return first "
        "page with session ID",
        {
            "type": "object",
            "properties": {
                "shortuuid": SHORTUUID,
                "page_size": {
                    "type": "integer",
                    "description": (
                        f"Number of characters per page (default: {VIEW_PAGE_SIZE}, "
                        f"max: {MAX_VIEW_PAGE_SIZE})"
                    ),
                    "minimum": 1,
                    "maximum": MAX_VIEW_PAGE_SIZE,
                },
            },
            "required": ["shortuuid"],
            "additionalProperties": False,
        },
    ),
    _function(
        "local-view_overlong_tooloutput_navigate",
        "Navigate through view content using view session ID",
        _navigate_schema(
            "view_session_id", "The view session ID returned from view_overlong_tool"
        ),
    ),
]
"""The four read-back tools, as function schemas."""
