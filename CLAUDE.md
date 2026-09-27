# Project Instructions

These instructions are loaded for coding agents working in this repo. Keep only always-relevant guidance here.

## This repo is public

Everything committed here is visible to anyone. Never add private material anywhere in the tree, including:

- Credentials, API keys, tokens, connection strings with passwords, or `.env` files. Only `.env.example` with empty or placeholder values is committed.
- Internal hostnames, account ids, customer names, or references to private Induction repos, services, or deployments.
- Unpublished results, internal design docs, or copied code from private repositories. Bring in a pattern by rewriting it for this repo, not by pasting.
- Personal data of any kind, including in test fixtures and seed data.

When in doubt, leave it out and ask. Grep for secrets and internal names before calling any change done.

## What this is

Context Cup benchmarks context-management strategies. Each **driver** implements a context manager (what to keep, compress, drop, or retrieve as an agent's context grows). The **course** runs every driver through the same AI benchmarks and scores them on accuracy and cost.

Winning, per benchmark, judged on the `tau_banking` and `toolathlon` suites: at the reference target, `gpt-5.6-sol@medium` until GPT-6 replaces it, against a fixed baseline per benchmark (`tau_banking` 0.35 and $50 per full run, `toolathlon` 0.67 and $65). A driver qualifies with a score of at least the baseline's and a full run (mean task cost × tasks) costing less than the baseline's; the leader is the cheapest qualifier, and with none there is no leader. Each driver stands on its latest finished run with ≥ 2 done trials in every task; older or thinner runs don't count. The rest rank below: reaches the score but costs more (cheapest first), then under the score (best score first). README "Winning" is the full statement and `course/site/src/lib/standings.ts` the code; keep them in step.

## Workspace layout

This is a pnpm workspace (TypeScript) with a uv workspace (Python) beside it. `course/*` is the framework, `engines/*` are what drivers build on, `drivers/*` holds one package per strategy, and `suites/*.json` say what a run covers. The course names every driver and engine by its folder (`drivers/base_python` is `base_python`, `engines/python` is `python`), never by a name in its manifest; `extends` and `--driver` take folder names, which must be unique. npm names (`@context-cup/*`, `@context-cup-drivers/*`) exist only for pnpm.

- `course/shared` owns env loading (`load_env.ts`, `REPO_ROOT`), `NODE_ENV` parsing, and the test bootstrap other packages import.
- `course/db` owns the Postgres schema (`src/schema.ts`), migrations under `drizzle/`, the connection, and the database test setup.
- `course/suite` is `bin/suite`: expands a suite file into harbor jobs, schedules them, ingests results.
- `course/runner` (Python) is the harbor agent that runs inside a trial: it owns the payloads and hands each turn to the driver. For a script agent (`kind: "agent"` without `harbor_agent`) its script agent for the benchmark (`context_cup_runner.agent`) sets the benchmark up as the loop would, then runs the package's `agent.sh`, which works the task itself.
- `course/proxy` is the forwarding proxy every model call goes through. It runs inside each trial container (bundled to one file by `src/bundle.ts`, started by the runner as root) and is the only process there holding provider keys; driver scripts run as the unprivileged `ccdriver` and cannot read them. Never pass a key through harbor's `--agent-env`, which reaches every command in the container.
- `course/protocol` is the protocol as a library: the `input.json`/`output.json` models, the provider adapters, the provider-neutral view, and `run_engine`, shared by the runner and every Python engine. The same package is `@context-cup/protocol`, the TypeScript twin (models, view, `runEngine`, the driver bundler) for the TypeScript engines; `tests/test_protocol_contract.py` checks both views read payloads alike.
- `engines/*` each define the `ctx` their drivers' `run(ctx)` receives: `engines/python` hands over the payloads (the provider SDKs come installed), `engines/pydantic` takes back Pydantic AI capabilities, `engines/litellm` hands over `ctx.llm` (a preconfigured litellm handle) and takes back its response. `engines/typescript` and `engines/aisdk` are the Python and litellm shapes in TypeScript (the second on the AI SDK); their `build.sh` bundles the driver and its npm packages on the host, since trial containers have the runner's `node` (`CC_NODE`) but no package manager.
- `bin/` wrappers stay at the root and run their owning package; `.env` lives at the root and is loaded via `REPO_ROOT`, so run anything from any directory.

The driver protocol is `docs/protocol.md`. Read it before touching a runner, an engine, or a driver; it is the contract, and a change there is a change to every driver. A package has one manifest, in its language's format: a Python package's `pyproject.toml` `[tool.context-cup]` table, a TypeScript package's `package.json` `contextCup` block (`package.json` wins if both). One reader per language implements this, `context_cup_protocol.read_manifest` and `@context-cup/protocol`'s `readManifest`, kept in step by `tests/test_protocol_contract.py`. A Python driver's `pyproject.toml` also lists its dependencies (its own project, not a uv workspace member) with the `uv.lock` beside it; the runner installs them, and every trial installs versions pinned from the lock files (`course/runner/src/context_cup_runner/pins.py`). `docs/drivers.md` is the driver author's guide (lanes, what `ctx` holds, debugging a failed turn), and each engine's README documents its `ctx`; update them with any change to what a driver receives.

Dependency rule: `drivers` build on `engines`; `course` invokes both by their scripts and never imports them; `engines` and `drivers` may import `context_cup_protocol` / `@context-cup/protocol` (`course/protocol`, the protocol as a library) and nothing else from `course`.

Third-party dependencies used by more than one package belong in the pnpm catalog in `pnpm-workspace.yaml`. Each package that uses one declares it with `"catalog:"` in its own manifest.

## Commands

```
bin/test                   TypeScript test suite (vitest; pass file paths, -t, --project)
uv run pytest              Python test suite (runner and engines)
bin/format                 format everything in place (prettier, ruff fixes, ruff format)
bin/lint                   every static check: prettier, ruff format, ruff check, tsc, mypy
bin/suite <key> --driver <d> [--target <t>] [--count N] [--dry_run]
                           run a suite file with one driver against one target (targets.json;
                           default the reference target, `REFERENCE_TARGET` in course/shared)
bin/deploy [--yes]         push origin/main to the production branch, which Render deploys
bin/daytona_sweep suite --suite_id <id> | errors [--dry_run]
                           delete Daytona sandboxes a run left behind
bin/db generate            write a migration for schema.ts changes
bin/db migrate             apply pending migrations
bin/db check               verify migrations, snapshots, and schema.ts agree
bin/db reset <migration>   drop everything and re-migrate (dev only)
```

Tests need a local Postgres. Each vitest worker gets its own database, created and migrated on first run, and every test body runs in a transaction that rolls back. Use `it` from `@context-cup/shared/test_helpers/index.js`, not from vitest directly, so the wrapper applies.

## Conventions

- Python is 3.12 everywhere: `.python-version` on the host, and a uv-managed 3.12 provisioned into every trial container for the runner loop and the engines. Never depend on a task image's own interpreter.
- ESM, TypeScript run directly by `tsx` and vitest (no build step). Relative imports carry the `.ts` extension; cross-package imports use the package's `./*.js` export map.
- Database columns are snake_case, and so is everything in code that names one: schema properties, query results, insert values. A row reads the same in TypeScript as in psql.
- The `trial` table is fully denormalized: each row carries every fact about its trial (suite, task, benchmark, driver, target, pass, harbor env, commits, CI run), copied from its job and suite when stored, so no question about trials needs a join. A fact added to `job` or `suite` that describes the trial goes on `trial` too.
- Prettier formats TypeScript and the rest of the tree, ruff formats and lints Python. Run `bin/format`, then `bin/lint`, before finishing.
