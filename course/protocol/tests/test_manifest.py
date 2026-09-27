"""The Python manifest reader's own failures; tests/test_protocol_contract.py
checks it reads every manifest as the TypeScript one does."""

from __future__ import annotations

from pathlib import Path

import pytest

from context_cup_protocol import read_manifest, read_pyproject


def test_a_file_that_does_not_parse_fails_naming_itself(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project\nname = 'x'\n")
    with pytest.raises(ValueError, match=r"pyproject\.toml: Expected ']'"):
        read_manifest(tmp_path)
    (tmp_path / "pyproject.toml").unlink()
    (tmp_path / "package.json").write_text("{ nope")
    with pytest.raises(ValueError, match=r"package\.json: Expecting"):
        read_manifest(tmp_path)


def test_no_pyproject_reads_as_empty(tmp_path: Path) -> None:
    assert read_pyproject(tmp_path) == {}
    assert read_manifest(tmp_path) is None
