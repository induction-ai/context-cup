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

## Workspace layout

This is a pnpm workspace. `course/*` is the framework and `drivers/*` holds one package per strategy. Packages are scoped `@context-cup/*`.

- `course/shared` owns env loading (`load_env.ts`, `REPO_ROOT`), `NODE_ENV` parsing, and the test bootstrap other packages import.
- `course/db` owns the Postgres schema (`src/schema.ts`), migrations under `drizzle/`, the connection, and the database test setup.
- `bin/` wrappers stay at the root and run their owning package; `.env` lives at the root and is loaded via `REPO_ROOT`, so run anything from any directory.

Dependency rule: `drivers` may import `course`; `course` never imports `drivers`.

Third-party dependencies used by more than one package belong in the pnpm catalog in `pnpm-workspace.yaml`. Each package that uses one declares it with `"catalog:"` in its own manifest.

## Commands

```
bin/test                   whole test suite (vitest; pass file paths, -t, --project)
pnpm typecheck             tsc across every package
pnpm lint / pnpm format    prettier
bin/db generate            write a migration for schema.ts changes
bin/db migrate             apply pending migrations
bin/db check               verify migrations, snapshots, and schema.ts agree
bin/db reset <migration>   drop everything and re-migrate (dev only)
```

Tests need a local Postgres. Each vitest worker gets its own database, created and migrated on first run, and every test body runs in a transaction that rolls back. Use `it` from `@context-cup/shared/test_helpers/index.js`, not from vitest directly, so the wrapper applies.

## Conventions

- ESM, TypeScript run directly by `tsx` and vitest (no build step). Relative imports carry the `.ts` extension; cross-package imports use the package's `./*.js` export map.
- Schema properties are camelCase; columns are snake_case via drizzle's casing option.
- Prettier is the formatter; run `pnpm format` before finishing.
