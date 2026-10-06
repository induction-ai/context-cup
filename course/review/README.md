# @context-cup/review

`bin/review_driver`: reviews a driver PR the way `.github/workflows/driver_review.yml` does, in three steps, each run only when the one before it passes.

- `src/static.ts`: reads the PR's files without running them. One `drivers/<name>/` directory and nothing else, a manifest the course loads, nothing that runs on the host.
- `src/claude.ts`: Claude Code, restricted to reading files, judges whether the driver is safe and honest to run. Its instructions, `src/claude_prompt.md`, stay general; maintainers' own go in `CC_REVIEW_INSTRUCTIONS`.
- `src/smoke.ts`: the smoke suites through `bin/suite`, at the reference target.

`src/cli.ts` is the command; "Enter it" in [docs/drivers.md](../../docs/drivers.md#enter-it) is the entrant's guide, and "Driver review" in [DEVELOPING.md](../../DEVELOPING.md) the maintainer's.
