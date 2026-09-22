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
course/     framework: benchmark runners, scoring, reporting
drivers/    one package per context-management strategy
```

Workspace packages are scoped `@context-cup/*`, for example
`@context-cup/db` or `@context-cup/driver-sliding-window`.

## Setup

Requires Node 24, pnpm 11 (see `.nvmrc` and `packageManager` in
`package.json`), and a local PostgreSQL server.

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
