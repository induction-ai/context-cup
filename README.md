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
plugs in is specified in [docs/protocol.md](docs/protocol.md); to write one,
start with [docs/drivers.md](docs/drivers.md).

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

A run is one suite file, one driver, and one target model.

```
bin/suite smoke_tau --driver base_passthrough --target gpt-5.5@medium
bin/suite toolathlon_local --driver base_truncate --target gpt-5.5@medium --count 2
bin/suite smoke_tau                       # prompts for the driver, then a target it supports
bin/suite smoke_tau --driver base_passthrough --target gpt-5.5@medium --dry_run
```

- `suites/*.json` list the tasks and how hard to run them (concurrency,
  timeouts). Nothing else.
- `targets.json` at the repo root names the target models: provider, model,
  reasoning effort, and an optional `concurrency` cap for provider rate
  limits, merged with the suite's and each task's caps by the scheduler. `--target` refers to a name in it (`TARGETS_FILE`
  overrides the path).
- `--driver` is a package under `drivers/`; it must declare support for the
  target's provider in its `package.json`. `base_passthrough` and
  `base_truncate` speak the turn protocol directly; `base_pydantic` is a
  Pydantic AI agent that owns the model side while the course runs the
  environment's tools, the baseline for drivers built from Pydantic AI
  Harness capabilities (`engines/pydantic`); `base_litellm` trims the
  conversation to the model's window with LiteLLM's `trim_messages` and
  sends it as chat messages, the baseline for litellm-based drivers (`engines/litellm`); `base_codex` is a whole agent
  run by harbor and compared on score and cost only.
- `--count` is attempts per task. `--task` narrows to named tasks.
- `--harbor_env daytona` runs in Daytona sandboxes instead of local Docker
  (needs `DAYTONA_API_KEY`).

Prerequisites: Docker running, uv, Python 3.12, provider keys in `.env`, and
the harbor fork, which the first run clones into `.harbor/repo`. Toolathlon
tasks that need credentials read `secrets/toolathlon_auth_configs.zip` when
present.

A job's score is the mean reward over its done trials (a verdict and no
error; errored or unfinished trials are left out, not counted as zero), its
cost the mean over those trials' prices, and a suite's score and cost are the
means of its jobs' values. Nothing is stored; every view computes it.

Output lands in `.temp/suites/<suite_id>/` (`results.json`, `results.txt`,
`calls.jsonl`, `logs/suite.log`, and every trial's artifacts) and in
Postgres: `suite`, `job`, `trial`, and `model_call` rows.

Every model call a trial makes goes through a proxy `bin/suite` starts on
the host (`course/proxy`): it holds the provider keys, forwards to the
provider, and writes `calls.jsonl`, which is where tokens and cost come
from. Containers never hold a key. Set `CC_SAVE_BODIES=1` to keep every
request and response body under `bodies/`, and `CC_PROXY_HOST` when the
containers reach the host by another name than `host.docker.internal`. A run inside GitHub Actions needs
`DATABASE_URL` for a Postgres the runner can reach; its suite row records the
workflow run id, attempt, and repository, and the results site links back to
the run.

## Results site

`course/site` is a small Next.js app over the database.

```
pnpm site:dev            # http://localhost:3300
```

`/suites` lists every run, newest first, and `/suites/<suite_id>` drills into
a run's tasks, jobs, trials, and each trial's model calls. `bin/suite` prints
the link to its run at start and finish; `SITE_URL` sets the base for those
links (default `http://localhost:3300`). Runs started in GitHub Actions show
a link to the workflow run.
