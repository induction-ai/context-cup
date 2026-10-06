# Developing Context Cup

How to set up, run, and operate the course. The competition itself (the
benchmarks, scoring, what wins, and how to enter: a pull request with your
driver) is in the [README](README.md).

## Layout

```
course/     framework: suite runner, harbor agents, database, scoring
engines/    what drivers build on: each turns the protocol into a small API
drivers/    one package per context-management strategy
suites/     which tasks, drivers, and models a run covers (toolathlon_local: the 35 tasks needing no credentials)
```

The course names every driver and engine by its folder: `drivers/base_python`
is the driver `base_python`, `engines/python` the engine `python`. A Python
package's manifest is its `pyproject.toml`, a TypeScript package's its
`package.json` (whose npm name, `@context-cup/*` or `@context-cup-drivers/*`,
only pnpm reads). How a driver
plugs in is specified in [docs/protocol.md](docs/protocol.md); to write one,
start with [docs/drivers.md](docs/drivers.md).

## Setup

Requires Node 24, pnpm 11 (see `.nvmrc` and `packageManager` in
`package.json`), Python 3.12 (`.python-version`; uv and pyenv both honour
it), uv, a local PostgreSQL server, and a Daytona API key (see
[Daytona or Docker](#daytona-or-docker)). With Daytona you do not need
Docker; it is only for running tasks on your own machine, which is much
slower.
Trial containers get their own uv-managed Python 3.12, whatever the task
image ships.

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
bin/suite tau_banking --driver base_python --harbor_env daytona    # at the reference target, gpt-6-sol@medium
bin/suite toolathlon_local --driver base_python --target gpt-5.5@medium --count 2 --harbor_env daytona
bin/suite smoke_tau --driver base_python --target gpt-5.5@medium --harbor_env daytona
bin/suite smoke_tau --harbor_env daytona       # prompts for the driver
bin/suite smoke_tau --driver base_python --target gpt-5.5@medium --dry_run
```

- `suites/*.json` list the tasks and how hard to run them (concurrency, a
  default `count`, and `timeout_minutes`; without one, harbor keeps each
  task's own timeout). Nothing else. Keys are checked strictly, so a typo is
  an error.
- `targets.json` at the repo root names the target models: provider, model,
  reasoning effort, and an optional `concurrency` cap for provider rate
  limits, merged with the suite's and each task's caps by the scheduler. `--target` refers to a name in it (`TARGETS_FILE`
  overrides the path). Without `--target`, a run uses the reference target
  (`REFERENCE_TARGET` in `course/shared/src/reference_target.ts`) when the
  driver supports its provider, and otherwise prompts for one.
- `--driver` is a package under `drivers/`; it must declare support for the
  target's provider in its manifest. `base_python`
  speaks the turn protocol directly, clipping oversized tool results; `base_pydantic` is a
  Pydantic AI agent that owns the model side while the course runs the
  environment's tools, doing the same clipping as a capability of its own,
  the example for drivers built on Pydantic AI (`engines/pydantic`); `base_litellm` does the same clipping on litellm chat
  messages, the baseline for litellm-based drivers (`engines/litellm`);
  `base_typescript` clips oversized tool results in TypeScript
  (`engines/typescript`), and `base_aisdk` does the same clipping on the AI SDK, the
  baseline for AI SDK drivers (`engines/aisdk`); `base_agent` is a whole
  agent written from scratch, its own loop over the task's MCP tools, the
  example for agents of your own; `base_codex` is a whole agent
  run by harbor and compared on score and cost only.
- `--count` is attempts per task. `--task` narrows to named tasks.
- `--harbor_env` picks where the tasks run: `daytona` or `docker` (the
  default). Use `daytona`; see below.

Prerequisites: uv, Python 3.12, provider keys in `.env`, `DAYTONA_API_KEY`
for Daytona or Docker running for Docker, and the harbor fork, which the
first run clones into `.harbor/repo`. Toolathlon
tasks that need credentials read `secrets/toolathlon_auth_configs.zip` when
present; every task image unzips it into its configs, on Docker and Daytona
alike.

The notion toolathlon tasks also need a Notion MCP login in `secrets/mcp`,
and refuse to launch without one:

```
MCP_REMOTE_CONFIG_DIR=secrets/mcp npx -y mcp-remote@0.1.16 https://mcp.notion.com/mcp
# approve in the browser, then Ctrl-C once it prints "Proxy established successfully"
```

Its refresh token rotates on every use. Docker trials mount `secrets/mcp`
live. Daytona sandboxes cannot mount a host path, so before each notion job
`bin/suite` refreshes a token with under an hour left and bakes a snapshot
into the notion tasks' `configs.zip` (`course/suite/src/mcp_auth.ts`).

### Daytona or Docker

Run on Daytona. Every task gets its own cloud sandbox and up to the suite's
`concurrency` (64 for the benchmark suites) run at once, so a full
`tau_banking` run takes about 40 minutes. Local Docker runs at most
`SUITE_DOCKER_COUNT` tasks at once, by default four, or two on Apple
silicon, where the x86 task images run under emulation. The same run then
takes hours.

1. Sign up at [daytona.io](https://www.daytona.io), which gives every
   competitor $100 in credits, then create an API key and set it as
   `DAYTONA_API_KEY` in `.env`.
2. Add `--harbor_env daytona` to `bin/suite`. You do not need Docker
   installed or running.

Nothing has to be committed or pushed first. Each trial uploads the engine
and driver from your working tree into its sandbox, everything in their
folders but `node_modules`, `.git`, `.venv`, `dist`, and caches, so keep
data and secrets out of a driver's folder. Provider keys go only to the
proxy inside the sandbox, as on Docker.

Each sandbox is labelled with its suite and job ids and stops itself once
it runs well past the job's time budget (`sandboxAutoStopMinutes` in
`course/suite/src/budget.ts`). A finished run deletes its own sandboxes;
`bin/daytona_sweep suite --suite_id <id>` deletes the ones an interrupted run
left behind, and `bin/daytona_sweep errors` the ones whose build failed,
which nothing else reclaims.

Scores and costs follow [Scoring](README.md#scoring) in the README. Nothing
is stored; every view computes them.

`--retry_errors N` reruns, after the suite finishes, the trials that did not
finish, up to N more passes. Each pass adds a job per task still short
(`job.pass` numbers it), and a task's score covers the done trials of all its
jobs; every attempt is kept. Passes are skipped when more than half the
trials failed, since that points at something a retry would only repeat. The
run exits non-zero only when a task is still short after the retries.

`--append <suite_id>` tops up a suite that ended short, for instance one that
missed the leaderboard's two done trials per task. It runs, under the same
suite, only the trials each of its tasks still owes to reach the suite's
count, as jobs numbered on from its last pass, and scores the suite over all
of them. The suite's own driver, target, count, and harbor env are the
defaults; a `--driver` or `--target` that disagrees is an error, and
`--count` may raise the count but not lower it. Each new trial records the
commit and CI run that ran it. `--retry_errors` applies as usual. In CI, pick
the same suite, driver, and target and put the suite id in `append`.

Output lands in `.temp/suites/<suite_id>/` (`results.json`, `results.txt`,
`logs/suite.log`, and every trial's artifacts) and in Postgres: `suite`,
`job`, `trial`, and `model_call` rows.

Every model call a trial makes goes through a proxy (`course/proxy`) that
runs inside that trial's container: `bin/suite` bundles it into one file,
and the runner uploads it with a `node` binary and starts it as root with
the provider keys. It forwards to the provider and writes the trial's
`agent/calls.jsonl`, which is where tokens and cost come from. Before the
driver sees a reply, it retries rate limits, overloaded and 5xx replies, and
an unreachable provider up to 4 times (2s to 60s backoff with jitter,
honouring `Retry-After`); an exhausted quota is never retried. Driver code
runs as an unprivileged user that cannot read the keys; each trial's
`agent/isolation.txt` records the check. Set `CC_SAVE_BODIES=1` to keep
every request and response body under the trial's `agent/bodies/`.

## Running in GitHub Actions

The **Suite** workflow (`.github/workflows/suite.yml`, run from the Actions
tab) is `bin/suite` on a hosted runner: pick the suite, driver, and target
(the suite and driver have no default),
and optionally a count and tasks. It runs on Daytona by default. It runs the
suite against the deployed database (the site's deploy migrates it), deletes the run's Daytona sandboxes (including
after a cancel), writes the results table to the run summary, and uploads
two artifacts: `suite-summary` (results and the suite log) and `suite-logs`
(all of `.temp/suites/`). Toolathlon runs take turns, restore the notion
login, and write it back when it rotated. The suite row records the
workflow run id, attempt, and repository, and the results site links back to
the run. The option lists mirror `suites/`, `drivers/`, and `targets.json`,
and a test fails when they drift.

**Daytona sweep** runs hourly and deletes context-cup sandboxes
whose build failed more than 12 hours earlier.

**Driver review** (`.github/workflows/driver_review.yml`) reviews an entry's
pull request against its merge commit, in two steps; entrants run both with
`bin/review_driver --smoke`:

1. **static**, on every push to a PR that touches `drivers/`:
   `bin/review_driver`, run from main, reads the PR without running it (see
   "Enter it" in [docs/drivers.md](docs/drivers.md#enter-it)). No secrets,
   and no PR code runs, which is what makes `pull_request_target` safe here.
2. **smoke**, when an owner, member, or collaborator comments
   `/review-driver <sha>`, naming the head commit they read (a push after
   that needs a new comment): the static check again, then `smoke_tau` and
   `smoke_toolathlon` with the driver at the reference target, on Daytona.
   Static has proved the merge commit is main plus the driver's directory,
   so the host runs only main's code and the driver runs only in sandboxes.
   Results go to a Postgres in the job, not the deployed database.

Each posts its result as a PR comment, updated in place on reruns. The
smoke job runs in the `driver-review` environment, which holds its own
secrets under names nothing else uses, so a missing one fails the job
instead of falling back to a repository secret:

| environment secret       | for                                                                       |
| ------------------------ | ------------------------------------------------------------------------- |
| `REVIEW_OPENAI_API_KEY`  | a separate, spend-capped key: entries' code runs with it in the sandboxes |
| `REVIEW_DAYTONA_API_KEY` | a separate Daytona organization or key with a small quota                 |

Give the environment required reviewers to add a second approval before the
smoke run. A maintainer adds a merged driver to the Suite workflow's
`driver` list.

Repository secrets:

| secret                                                  | for                                                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                          | the production Postgres; the runner must be able to reach it                                                   |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | the providers the chosen target and driver call                                                                |
| `DAYTONA_API_KEY`                                       | Daytona runs and the sweep                                                                                     |
| `TOOLATHLON_AUTH_CONFIGS_B64`                           | optional: `base64 < secrets/toolathlon_auth_configs.zip \| gh secret set TOOLATHLON_AUTH_CONFIGS_B64`          |
| `TOOLATHLON_MCP_AUTH_B64`                               | the notion tasks' login; see below                                                                             |
| `INDUCTION_BOT_APP_ID`, `INDUCTION_BOT_PRIVATE_KEY`     | the induction-bot GitHub App, installed on this repository with Secrets write, to store a rotated notion login |

The repository variable `SITE_URL` points printed links at the deployed
results site.

CI gets its own Notion login, since a refresh from either copy would spend
the other's token. To set it:

```
mkdir /tmp/ci-grant
MCP_REMOTE_CONFIG_DIR=/tmp/ci-grant npx -y mcp-remote@0.1.16 https://mcp.notion.com/mcp
# approve, then Ctrl-C once it prints "Proxy established successfully"
COPYFILE_DISABLE=1 tar czf - -C /tmp/ci-grant . | base64 | gh secret set TOOLATHLON_MCP_AUTH_B64
rm -rf /tmp/ci-grant
```

## Results site

`course/site` is a small Next.js app over the database; the README's
[Leaderboard](README.md#leaderboard) describes its pages.

```
pnpm site:dev            # http://localhost:3300
```

`bin/suite` prints the link to its run at start and finish; `SITE_URL` sets
the base for those links (default `http://localhost:3300`). Runs started in
GitHub Actions show a link to the workflow run.

## Deploying

`render/render.yaml` is a Render Blueprint for the site and its Postgres
database, in one environment. The site builds from the `production` branch;
`bin/deploy` pushes `origin/main` there (`--commit <sha>` deploys an earlier
commit of main, `--yes` skips the prompt). Each deploy applies pending
migrations before it goes live (`pnpm prelaunch`). A package that deploys
keeps its Render scripts in its own `render/` directory
(`course/site/render/build.sh`).

The database accepts connections from anywhere, since `bin/suite` writes to
it from wherever it runs; set the GitHub `DATABASE_URL` secret to its external
connection string, and the `SITE_URL` variable to the site's address.
