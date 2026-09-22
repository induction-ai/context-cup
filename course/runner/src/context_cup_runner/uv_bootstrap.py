"""The uv release the runner uploads into every trial container.

Task images cannot be relied on for uv, curl, or wget (python:3.12-slim has
none of them), so the host fetches the binary for the container's
architecture once, caches it, and uploads it. Kept free of harbor imports so
it can be used and tested outside harbor's process.
"""

from __future__ import annotations

import io
import os
import tarfile
import urllib.request
from pathlib import Path

UV_VERSION = os.environ.get("CC_UV_VERSION", "0.12.17")
UV_RELEASES = "https://github.com/astral-sh/uv/releases/download"
UV_HOST_CACHE = (
    Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    / "context-cup"
    / "uv"
)

_ARCH = {
    "x86_64": "x86_64",
    "amd64": "x86_64",
    "aarch64": "aarch64",
    "arm64": "aarch64",
}


def uv_target_triple(machine: str, libc: str) -> str:
    """The uv release asset for a container's `uname -m` and libc."""
    try:
        cpu = _ARCH[machine]
    except KeyError:
        raise ValueError(
            f"no uv build for container architecture {machine!r}"
        ) from None
    return f"{cpu}-unknown-linux-{'musl' if libc == 'musl' else 'gnu'}"


def cached_uv_binary(triple: str, version: str = UV_VERSION) -> Path:
    """Path of the uv binary for `triple` in the host cache, downloading the
    release tarball on first use."""
    binary = UV_HOST_CACHE / version / triple / "uv"
    if binary.is_file():
        return binary
    url = f"{UV_RELEASES}/{version}/uv-{triple}.tar.gz"
    with urllib.request.urlopen(url, timeout=120) as response:
        payload = response.read()
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as tar:
        member = next(
            (m for m in tar.getmembers() if m.isfile() and m.name.endswith("/uv")),
            None,
        )
        if member is None:
            raise RuntimeError(f"{url} holds no uv binary")
        extracted = tar.extractfile(member)
        if extracted is None:
            raise RuntimeError(f"{url}: cannot read {member.name}")
        binary.parent.mkdir(parents=True, exist_ok=True)
        binary.write_bytes(extracted.read())
    binary.chmod(0o755)
    return binary
