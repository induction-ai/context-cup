# course/site

The results site: Next.js App Router, server components reading Postgres
through `@context-cup/db`. No client-side data fetching, no API routes.

## Bootstrap first, themed by its variables

The site is Bootstrap 5, vendored as Sass source in `vendor/bootstrap`
(5.3.8, exactly as upstream ships it: never edit it, and Prettier skips
it). `app/globals.scss` sets Bootstrap's own variables to the Context Cup
theme (cream paper, ink borders, red accent, square corners, a hard offset
shadow, a pixel display face over a monospace body) and then imports it, so
every component and utility comes out themed. Before writing any markup or
CSS, look for the Bootstrap component or utility that does the job and use
it:

- Layout: `container-fluid`, grid (`row`, `col-*`), spacing utilities (`mt-3`,
  `gap-3`, `mb-0`), `d-flex`, `align-items-*`.
- Navigation: `navbar`, `nav`, `nav-pills`, `nav-tabs`, `breadcrumb` (an
  `<ol>`, not a `<p>` of links), `pagination` (`page-item`, `page-link`,
  `active`, `disabled`).
- Data: `table table-sm table-striped table-hover align-middle` in a
  `table-responsive` wrapper, `table-active` for summary rows,
  `table-warning` for a leader's row (gold) and `table-info` for the
  baseline's (sky), `badge text-bg-*` for statuses, `<dl class="row">` with
  `col-*` on `dt`/`dd` for facts.
- Messages: `alert alert-*` for errors and empty states, `text-body-secondary`
  for muted text, `text-danger` / `text-success` for pass and fail values.
- Text: `font-monospace` for ids, names, and numbers; `text-end` for numeric
  columns; heading size utilities (`h3`, `h5`) instead of custom sizes.
  Headings and `display-*` set in the pixel face, uppercase; `text-primary`
  is the brand red.
- Surfaces: `border` (2px ink), `shadow` (the hard offset shadow),
  `bg-body-tertiary` (paper). A navy panel is Bootstrap's dark colour mode:
  `data-bs-theme="dark"` with `bg-body text-body`, and `data-bs-theme="light"`
  on anything inside it that stays light (the top drivers' table).
- Buttons: `btn btn-primary` (red, inked, shadowed).

Keeping the theme tight:

- A change to the look is a Bootstrap variable in `globals.scss`, above the
  import, not a rule overriding what Bootstrap generated. The palette is the
  `$cc-*` Sass variables there; never put a colour inline in a page.
- The rules after the import are only what Bootstrap has no variable for
  (uppercase headings, inked button borders, the site bar's current-page
  mark, the hero, the code sample), plus a few `cc-` classes. Add one only
  when no variable or utility will do.
- The fonts are loaded by `next/font` in `app/layout.tsx` (Press Start 2P as
  `--cc-font-display`, IBM Plex Mono as `--cc-font-mono`); the Sass refers
  only to those variables.
- Bootstrap 5's Sass trips Dart Sass's deprecations (`@import` and friends);
  `next.config.ts` silences exactly those. To upgrade Bootstrap, replace
  `vendor/bootstrap` with the new release's `scss/` and `LICENSE`.
- Icons are `PixelIcon` (`src/components/pixel_icon.tsx`): rectangles on a
  16-unit grid in `currentColor`. Add a shape there rather than an icon
  library.
- The home page's hero art is `public/hero.png`, cut from the designer's
  mock with a transparent edge so it sits on the cream.

## Conventions

- Sorting and paging are URL-driven (`?sort=&dir=&page=&per=`) and resolved
  in SQL (`src/lib/queries.ts`); pages stay server-rendered. Use `SortTh`
  for sortable headers and the helpers in `src/lib/sort.ts`.
- Scores are computed, never stored: a task is the mean over its done
  trials in all its jobs (a `--retry_errors` pass adds jobs to a task), a
  suite the mean over its tasks (`src/lib/aggregate.ts`, and the SQL in
  `listSuites`).
- The leaderboard's rule (suites, baselines, reference target,
  the ranking) is `src/lib/standings.ts`, pure and tested; the page and the
  chart only draw it. The chart (`src/components/cost_score_chart.tsx`) is
  SVG with no chart library and a client component: hovering a dot (or its
  table row, through `BoardFocus` in `src/components/board_focus.tsx`)
  shows its score and cost, clicking pins the tooltip until a click
  elsewhere or Escape. Which run a driver stands on is SQL
  (`eligible` and `onBoard` in `src/lib/queries.ts`); `disqualifications`
  states the same rule in TypeScript for the `/suites` column, so change
  them together. Keep all of it in step with README "Winning".
- Query functions return typed rows; aggregation and formatting are pure
  functions with tests under `tests/`.
- The home page's code samples are the base drivers themselves, one tab
  per lane, read from `drivers/` when the page renders
  (`src/lib/sample_driver.ts`) and coloured by `src/lib/highlight.ts`. Add
  or rename a lane there when `drivers/` changes; its test fails if a file
  moves.
- Off-site links (the README's sections, the driver guide) come from
  `src/lib/links.ts`.
- Tests: `bin/test --project site`. Build check: `pnpm site:build`.
