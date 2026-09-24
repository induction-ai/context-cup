"""The Node release the runner uploads into every trial container to run the
course proxy.

Like uv (uv_bootstrap.py), Node cannot be expected in a task image, so the
host fetches the `node` binary for the container's architecture and libc
once, checks it against the release's published SHA-256, caches it, and
uploads it. glibc builds come from nodejs.org; musl builds from Node's
unofficial-builds site. Kept free of harbor imports so it can be used and
tested outside harbor's process.
"""

from __future__ import annotations

import hashlib
import io
import os
import tarfile
import urllib.request
from pathlib import Path

NODE_VERSION = os.environ.get("CC_NODE_VERSION", "24.21.0")
NODE_RELEASES = "https://nodejs.org/dist"
NODE_MUSL_RELEASES = "https://unofficial-builds.nodejs.org/download/release"
NODE_HOST_CACHE = (
    Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    / "context-cup"
    / "node"
)

_ARCH = {
    "x86_64": "x64",
    "amd64": "x64",
    "aarch64": "arm64",
    "arm64": "arm64",
}


def node_platform(machine: str, libc: str) -> str:
    """The Node release platform for a container's `uname -m` and libc,
    e.g. `linux-arm64` or `linux-x64-musl`."""
    try:
        cpu = _ARCH[machine]
    except KeyError:
        raise ValueError(
            f"no Node build for container architecture {machine!r}"
        ) from None
    return f"linux-{cpu}{'-musl' if libc == 'musl' else ''}"


def node_release_url(platform: str, version: str = NODE_VERSION) -> str:
    base = NODE_MUSL_RELEASES if platform.endswith("-musl") else NODE_RELEASES
    return f"{base}/v{version}/node-v{version}-{platform}.tar.xz"


def _fetch(url: str) -> bytes:
    try:
        with urllib.request.urlopen(url, timeout=300) as response:
            return bytes(response.read())
    except OSError as exc:
        raise RuntimeError(f"could not download {url}: {exc}") from exc


def _published_sha256(url: str) -> str:
    base, name = url.rsplit("/", 1)
    for line in _fetch(f"{base}/SHASUMS256.txt").decode().splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == name:
            return parts[0]
    raise RuntimeError(f"{base}/SHASUMS256.txt lists no {name}")


def cached_node_binary(platform: str, version: str = NODE_VERSION) -> Path:
    """Path of the `node` binary for `platform` in the host cache,
    downloading and verifying the release tarball on first use."""
    binary = NODE_HOST_CACHE / version / platform / "node"
    if binary.is_file():
        return binary
    url = node_release_url(platform, version)
    payload = _fetch(url)
    digest = hashlib.sha256(payload).hexdigest()
    expected = _published_sha256(url)
    if digest != expected:
        raise RuntimeError(f"{url}: sha256 {digest} does not match {expected}")
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:xz") as tar:
        member = next(
            (
                m
                for m in tar.getmembers()
                if m.isfile() and m.name.endswith("/bin/node")
            ),
            None,
        )
        if member is None:
            raise RuntimeError(f"{url} holds no bin/node")
        extracted = tar.extractfile(member)
        if extracted is None:
            raise RuntimeError(f"{url}: cannot read {member.name}")
        binary.parent.mkdir(parents=True, exist_ok=True)
        partial = binary.with_suffix(".partial")
        partial.write_bytes(extracted.read())
    partial.chmod(0o755)
    partial.replace(binary)
    return binary
