"""What the runner sets up in a trial container around the loop: the course
proxy, and the unprivileged user driver scripts run as. Used from harbor's
process by both CourseAgent and CodexAgent.

The proxy runs in the container as root, the only process there holding the
provider keys. It listens on 127.0.0.1 only and writes the trial's call log
to /logs/agent/calls.jsonl. The keys reach it through a root-only file that
it deletes on start, never through harbor's `--agent-env` (applied to every
exec, the loop's included) or a command line (readable by any user).
"""

from __future__ import annotations

import os
import shlex
import tempfile
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment

from .chain import DROP_TOOLS, drop_argv
from .node_bootstrap import cached_node_binary, node_platform

INSTALL_ROOT = "/installed-agent"
AGENT_DIR = "/logs/agent"

NODE_DIR = f"{INSTALL_ROOT}/.node"
NODE_BIN = f"{NODE_DIR}/node"
PROXY_DIR = f"{INSTALL_ROOT}/.proxy"
REMOTE_PROXY_BUNDLE = f"{PROXY_DIR}/proxy.cjs"
PROXY_PORT = 18080
PROXY_URL = f"http://127.0.0.1:{PROXY_PORT}"
CALLS_FILE = f"{AGENT_DIR}/calls.jsonl"
BODIES_DIR = f"{AGENT_DIR}/bodies"
PROXY_LOG = f"{AGENT_DIR}/proxy.txt"
ISOLATION_LOG = f"{AGENT_DIR}/isolation.txt"
# Root only (0700): the keys file for the moment before the proxy reads it,
# and the proxy's pid.
SECRET_DIR = "/var/lib/context-cup"
REMOTE_KEYS = f"{SECRET_DIR}/keys.env"
PROXY_PID = f"{SECRET_DIR}/proxy.pid"

DRIVER_USER = "ccdriver"
DRIVER_HOME = f"/home/{DRIVER_USER}"

# What the proxy needs from the host: provider keys, and upstream overrides.
PROXY_ENV_NAMES = (
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "CC_UPSTREAM_OPENAI",
    "CC_UPSTREAM_ANTHROPIC",
    "CC_UPSTREAM_GEMINI",
)
BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_PROXY_BUNDLE = REPO_ROOT / "course" / "proxy" / "dist" / "proxy.cjs"


def proxy_bundle() -> Path:
    """The bundled proxy bin/suite built (CC_PROXY_BUNDLE), or the default
    build location."""
    bundle = Path(os.environ.get("CC_PROXY_BUNDLE") or DEFAULT_PROXY_BUNDLE)
    if not bundle.is_file():
        raise RuntimeError(
            f"no proxy bundle at {bundle}; build it with "
            "`pnpm --filter @context-cup/proxy build` (bin/suite does)"
        )
    return bundle


async def probe_platform(
    agent: BaseInstalledAgent, environment: BaseEnvironment
) -> tuple[str, str]:
    """The container's `uname -m` and libc (`gnu` or `musl`)."""
    probe = await agent.exec_as_root(
        environment,
        command="uname -m; (ls /lib/ld-musl-* >/dev/null 2>&1 && echo musl) || echo gnu",
    )
    lines = [ln.strip() for ln in (probe.stdout or "").splitlines() if ln.strip()]
    if len(lines) < 2:
        raise RuntimeError(
            f"could not probe the container architecture: {probe.stdout!r}"
        )
    return lines[0], lines[1]


def keys_file_text(values: dict[str, str]) -> str:
    return "".join(f"{name}={shlex.quote(value)}\n" for name, value in values.items())


def proxy_command(*, target: dict[str, Any] | None, save_bodies: bool) -> list[str]:
    argv = [
        NODE_BIN,
        REMOTE_PROXY_BUNDLE,
        "--port",
        str(PROXY_PORT),
        "--calls",
        CALLS_FILE,
    ]
    if save_bodies:
        argv += ["--save-bodies", BODIES_DIR]
    provider = (target or {}).get("provider")
    model = (target or {}).get("model")
    if provider and model:
        argv += ["--default-provider", str(provider), "--default-model", str(model)]
    return argv


async def upload_node(
    agent: BaseInstalledAgent, environment: BaseEnvironment, platform: tuple[str, str]
) -> None:
    """Put the pinned node release at NODE_BIN, built for the container, once.
    The proxy runs on it, and driver scripts get it as CC_NODE."""
    present = await agent.exec_as_root(
        environment, command=f"test -x {NODE_BIN} && echo present || true"
    )
    if "present" in (present.stdout or ""):
        return
    node = cached_node_binary(node_platform(*platform))
    await agent.exec_as_root(environment, command=f"mkdir -p {NODE_DIR}")
    await environment.upload_file(node, NODE_BIN)
    await agent.exec_as_root(environment, command=f"chmod 755 {NODE_DIR} {NODE_BIN}")


async def start_proxy(
    agent: BaseInstalledAgent,
    environment: BaseEnvironment,
    *,
    platform: tuple[str, str],
    target: dict[str, Any] | None,
    save_bodies: bool,
) -> None:
    """Upload node (unless it is there) and the proxy bundle, hand the proxy
    the keys, start it detached as root, and wait until it answers."""
    await upload_node(agent, environment, platform)
    await agent.exec_as_root(
        environment,
        command=(
            f"mkdir -p {PROXY_DIR} {AGENT_DIR} && "
            f"mkdir -p -m 700 {SECRET_DIR} && chmod 700 {SECRET_DIR}"
        ),
    )
    await environment.upload_file(proxy_bundle(), REMOTE_PROXY_BUNDLE)
    await agent.exec_as_root(environment, command=f"chmod 644 {REMOTE_PROXY_BUNDLE}")

    # harbor's own process env, never the agent's extra env: that is what
    # every exec sees, and CodexAgent puts the placeholder key there.
    values = {
        name: value for name in PROXY_ENV_NAMES if (value := os.environ.get(name))
    }
    fd, local = tempfile.mkstemp(prefix="cc-keys-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(keys_file_text(values))
        await environment.upload_file(local, REMOTE_KEYS)
    finally:
        os.unlink(local)

    # The inner shell reads the keys into its own environment, deletes the
    # file, and becomes the proxy; nothing else ever sees the values. The
    # redirects wrap the whole backgrounded subshell: left on the inner
    # command, the subshell keeps the exec's stdout open for the proxy's
    # lifetime and Daytona's exec never returns.
    inner = (
        f"echo $$ > {PROXY_PID}; set -a; . {REMOTE_KEYS}; set +a; "
        f"rm -f {REMOTE_KEYS}; exec {shlex.join(proxy_command(target=target, save_bodies=save_bodies))}"
    )
    await agent.exec_as_root(
        environment,
        command=(
            f"chown root:root {REMOTE_KEYS} && chmod 600 {REMOTE_KEYS} || exit 1; "
            f"launch=$(command -v setsid || command -v nohup || true); "
            f"(cd / && exec $launch env -i PATH={BASE_PATH} HOME=/root "
            f"sh -c {shlex.quote(inner)}) </dev/null >>{PROXY_LOG} 2>&1 &"
        ),
    )
    await wait_for_proxy(agent, environment)


async def wait_for_proxy(
    agent: BaseInstalledAgent, environment: BaseEnvironment, *, timeout_sec: int = 30
) -> None:
    """Until the proxy answers /healthz; its log is in the error if it never
    does."""
    probe = (
        f"fetch('{PROXY_URL}/healthz')"
        ".then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
    )
    tries = timeout_sec * 5
    await agent.exec_as_root(
        environment,
        command=(
            f"for i in $(seq 1 {tries}); do "
            f"{NODE_BIN} -e {shlex.quote(probe)} && exit 0; sleep 0.2; done; "
            f"echo 'proxy never answered {PROXY_URL}/healthz' >&2; "
            f"tail -n 40 {PROXY_LOG} >&2; exit 1"
        ),
        timeout_sec=timeout_sec + 30,
    )


async def stop_proxy(agent: BaseInstalledAgent, environment: BaseEnvironment) -> None:
    """Best effort: the container goes away soon anyway."""
    try:
        await agent.exec_as_root(
            environment,
            command=(
                f"if [ -f {PROXY_PID} ]; then kill $(cat {PROXY_PID}) 2>/dev/null; "
                f"rm -f {PROXY_PID}; fi; true"
            ),
        )
    except Exception as exc:  # noqa: BLE001 - never fail a finished trial over this
        agent.logger.warning(f"could not stop the proxy: {exc}")


async def create_driver_user(
    agent: BaseInstalledAgent, environment: BaseEnvironment
) -> str:
    """Create DRIVER_USER and return the tool that switches to it: the first
    of DROP_TOOLS that really runs a command as that user here."""
    await agent.exec_as_root(
        environment,
        command=(
            f"if id -u {DRIVER_USER} >/dev/null 2>&1; then :; "
            f"elif command -v useradd >/dev/null 2>&1; then "
            f"useradd --system --user-group --no-create-home --home-dir {DRIVER_HOME} "
            f"--shell /bin/sh {DRIVER_USER}; "
            f"elif command -v adduser >/dev/null 2>&1; then "
            f"adduser -S -D -H -h {DRIVER_HOME} -s /bin/sh {DRIVER_USER}; "
            f"else echo 'cannot create {DRIVER_USER}: the image has neither useradd "
            f"nor adduser' >&2; exit 1; fi; "
            f"mkdir -p {DRIVER_HOME} && chown {DRIVER_USER} {DRIVER_HOME} && "
            f"chmod 700 {DRIVER_HOME}"
        ),
    )
    ids = await agent.exec_as_root(
        environment, command=f"id -u {DRIVER_USER}; id -g {DRIVER_USER}"
    )
    uid, gid = (int(v) for v in (ids.stdout or "").split()[:2])
    tries = [
        f"command -v {tool} >/dev/null 2>&1 && "
        f'[ "$({shlex.join(drop_argv(tool, DRIVER_USER, uid, gid, ["id", "-u"]))} 2>/dev/null)" = "{uid}" ] '
        f"&& echo {tool} && exit 0"
        for tool in DROP_TOOLS
    ]
    found = await agent.exec_as_root(
        environment,
        command="; ".join([*tries, "exit 0"]),
    )
    tool = (found.stdout or "").strip().splitlines()[-1:] or [""]
    if tool[0] not in DROP_TOOLS:
        raise RuntimeError(
            f"cannot run commands as {DRIVER_USER}: none of "
            f"{', '.join(DROP_TOOLS)} works in this image"
        )
    return tool[0]


async def check_isolation(
    agent: BaseInstalledAgent, environment: BaseEnvironment, tool: str
) -> None:
    """Prove, and log, that the driver user cannot read the proxy's
    environment (where the keys are) while root can, and that the keys file
    is gone. Fails the trial otherwise."""
    ids = await agent.exec_as_root(
        environment,
        command=f"id -u {DRIVER_USER}; id -g {DRIVER_USER}; cat {PROXY_PID}",
    )
    uid, gid, pid = (int(v) for v in (ids.stdout or "").split()[:3])
    environ = f"/proc/{pid}/environ"

    def as_driver(argv: list[str]) -> str:
        return shlex.join(drop_argv(tool, DRIVER_USER, uid, gid, argv))

    def fail(message: str) -> str:
        return f"{{ echo 'FAIL: {message}' | tee -a {ISOLATION_LOG} >&2; exit 1; }}"

    result = await agent.exec_as_root(
        environment,
        command=(
            f"keys=$(tr '\\0' '\\n' < {environ} | grep -c '_API_KEY=' || true); "
            f"{as_driver(['cat', '/proc/self/status'])} >/dev/null 2>&1 || "
            f"{fail(f'cannot run cat as {DRIVER_USER}, so the check proves nothing')}; "
            f"{as_driver(['cat', environ])} >/dev/null 2>&1 && "
            f"{fail(f'{DRIVER_USER} can read {environ} of the proxy')}; "
            f"[ ! -e {REMOTE_KEYS} ] || {fail(f'{REMOTE_KEYS} still exists')}; "
            f'echo "ok: the proxy (pid {pid}) holds $keys key(s) as root; '
            f'{DRIVER_USER} (uid {uid}, via {tool}) cannot read {environ}" '
            f"| tee -a {ISOLATION_LOG}"
        ),
    )
    agent.logger.info((result.stdout or "").strip())
