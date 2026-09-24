# course/site

The results site: Next.js App Router, server components reading Postgres
through `@context-cup/db`. No client-side data fetching, no API routes.

## Bootstrap first

The site uses Bootstrap 5 (`bootstrap/dist/css/bootstrap.min.css`, imported
once in `app/layout.tsx`). Before writing any markup or CSS, look for the
Bootstrap component or utility that does the job and use it:

- Layout: `container-fluid`, grid (`row`, `col-*`), spacing utilities (`mt-3`,
  `gap-3`, `mb-0`), `d-flex`, `align-items-*`.
- Navigation: `navbar`, `nav`, `breadcrumb` (an `<ol>`, not a `<p>` of links),
  `pagination` (`page-item`, `page-link`, `active`, `disabled`).
- Data: `table table-sm table-striped table-hover align-middle` in a
  `table-responsive` wrapper, `table-active` for summary rows, `badge text-bg-*`
  for statuses, `<dl class="row">` with `col-*` on `dt`/`dd` for facts.
- Messages: `alert alert-*` for errors and empty states, `text-body-secondary`
  for muted text, `text-danger` / `text-success` for pass and fail values.
- Text: `font-monospace` for ids, names, and numbers; `text-end` for numeric
  columns; heading size utilities (`h3`, `h5`) instead of custom sizes.

`app/globals.css` holds only what Bootstrap lacks (tabular numerals, the
width cap on error text in table cells, the summary cursor). Adding a rule
there needs a reason Bootstrap cannot cover; a new class name is a smell.

## Conventions

- Sorting and paging are URL-driven (`?sort=&dir=&page=&per=`) and resolved
  in SQL (`src/lib/queries.ts`); pages stay server-rendered. Use `SortTh`
  for sortable headers and the helpers in `src/lib/sort.ts`.
- Scores are computed, never stored: a task is the mean over its done
  trials in all its jobs (a `--retry_errors` pass adds jobs to a task), a
  suite the mean over its tasks (`src/lib/aggregate.ts`, and the SQL in
  `listSuites`).
- Query functions return typed rows; aggregation and formatting are pure
  functions with tests under `tests/`.
- Tests: `bin/test --project site`. Build check: `pnpm site:build`.
