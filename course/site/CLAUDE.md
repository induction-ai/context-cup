# course/site

The results site: Next.js App Router, server components reading Postgres
through `@context-cup/db`. No client-side data fetching, no API routes.

## Bootstrap, themed

The site uses Bootstrap 5 for structure and components
(`bootstrap/dist/css/bootstrap.min.css`, imported once in `app/layout.tsx`),
but not for its look: `app/globals.css` re-themes it to the Context Cup
style (cream paper, ink borders, red accent, square corners, hard offset
shadows, a pixel display face over a monospace body). Before writing any
markup or CSS, look for the Bootstrap component or utility that does the job
and use it; the theme restyles it for you:

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
- Buttons: `btn btn-primary` (red) and `btn btn-outline-dark`.

How the theme works, so a change stays in it:

- Colours, fonts, borders, and radii are Bootstrap's own CSS variables
  (`--bs-*`), set at the top of `globals.css` from the `--cc-*` palette.
  Change the palette there, never with a colour inline in a page. Bootstrap
  components that hard-code their colours (`.btn-*`, `.pagination`,
  `.table-*` variants) get their component variables overridden below.
- The fonts are loaded by `next/font` in `app/layout.tsx` (Silkscreen as
  `--cc-font-display`, IBM Plex Mono as `--cc-font-mono`); the CSS only
  refers to those variables.
- What Bootstrap has no component for (the inked boxes, the dark code and
  standings panels, the icon tiles, the code sample's token colours) is a
  `cc-` class in `globals.css`. Add one only when no Bootstrap class or
  variable will do.
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
- The home page's code sample (`src/lib/sample_driver.ts`) is a real
  driver against the Python engine's `ctx`, coloured by `src/lib/highlight.ts`;
  keep it in step with `docs/drivers.md` and `drivers/base_python`.
- Off-site links (the README's sections, the driver guide) come from
  `src/lib/links.ts`.
- Tests: `bin/test --project site`. Build check: `pnpm site:build`.
