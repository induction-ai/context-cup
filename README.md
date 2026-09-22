# Context Cup

A benchmark harness for context-management strategies, in the spirit of a kart
race. Each **driver** implements a context manager (what to keep, compress,
drop, or retrieve as an agent's context grows). The **course** runs every
driver through the same AI benchmarks and scores them on two axes:

- **Accuracy**: how well the model performs on the benchmark tasks with the
  driver managing its context.
- **Cost**: tokens and dollars spent to get there.

## Layout

```
course/     framework: suite runner, harbor agents, database, scoring
engines/    what drivers build on: each turns the protocol into a small API
drivers/    one package per context-management strategy
suites/     which tasks, drivers, and models a run covers (toolathlon_local: the 35 tasks needing no credentials)
```

Workspace packages are scoped `@context-cup/*`, for example `@context-cup/db`,
`@context-cup/engine-python`, while drivers use `@context-cup-drivers/*`, for example
`@context-cup-drivers/base_truncate`. How a driver
plugs in is specified in [docs/protocol.md](docs/protocol.md).

## Setup

Requires Node 24, pnpm 11 (see `.nvmrc` and `packageManager` in
`package.json`), Python 3.12 (`.python-version`; uv and pyenv both honour
it), uv, Docker, and a local PostgreSQL server. Trial containers get their
own uv-managed Python 3.12, whatever the task image ships.

```
cp .env.example .env
createdb context_cup
pnpm install
bin/db migrate
bin/test
pnpm typecheck
```

## Database

`course/db` owns the Postgres schema (drizzle-orm) and its migrations. The
schema lives in `course/db/src/schema.ts`; `course/shared` holds env loading
and the test bootstrap that other course packages import.

```
bin/db generate            write a migration for schema.ts changes
bin/db migrate             apply pending migrations to DATABASE_URL
bin/db check               verify migrations, snapshots, and schema.ts agree
bin/db reset <migration>   drop everything and re-migrate to that point (dev only)
```

Tests run against one database per vitest worker (`context_cup_test_1`,
`_2`, ...), created and migrated on the first run. Every test body runs in a
transaction that rolls back afterwards; set `LEAVEDB=true` to keep the rows
for inspection.

## Running a suite

A suite file under `suites/` names the tasks, the drivers, and the targets
(provider and model) to race. `bin/suite` expands the matrix into one harbor
job per cell, runs them under a concurrency cap, and records every trial and
model call in Postgres plus a `results.json` next to the logs.

Prerequisites beyond the setup above:

- Docker running (the default sandbox), or `DAYTONA_API_KEY` for `--harbor_env daytona`.
- `uv` and Python 3.12 or newer. The first run clones the harbor fork into
  `.harbor/repo` and syncs its venv; set `HARBOR_DIR=global` to use a harbor on
  your PATH instead.
- Provider keys in `.env`: `OPENAI_API_KEY` is always needed (the tau3 user
  simulator runs on it), plus the key for each target's provider.
- Optional `secrets/` (gitignored): `toolathlon_auth_configs.zip` unlocks the
  71 toolathlon tasks that need real service credentials, and `mcp/` holds the
  Notion OAuth state for the nine Notion tasks.

```
bin/suite smoke_tau --dry_run          print the jobs and harbor commands, run nothing
bin/suite smoke_tau                    one banking task, one driver, the default target
bin/suite toolathlon --task sales_accounting --driver base_truncate
bin/suite tau_banking --target claude-sonnet-4-6 --harbor_env daytona
```

Naming a task, driver, or target on the command line selects only those and
includes entries marked `explicit_only` in the suite file. Output lands under
`.temp/suites/<suite_id>/`: one log per job, harbor's own job directory with
each trial's `agent/turns/`, and `results.json` and `results.txt` at the end.
Local docker runs are capped at two jobs at once on arm64 and four on x86;
`SUITE_DOCKER_COUNT` overrides that.
