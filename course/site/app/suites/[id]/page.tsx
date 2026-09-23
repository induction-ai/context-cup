import { SortTh } from "@/src/components/sort_th";
import {
  cellFor,
  suiteTotals,
  taskCells,
  type TaskCell,
} from "@/src/lib/aggregate";
import {
  cents,
  count,
  duration,
  elapsed,
  githubRunUrl,
  reward,
  shortSha,
  targetSpec,
  tokens,
  truncate,
  when,
} from "@/src/lib/format";
import { loadSuite, type TrialRow } from "@/src/lib/queries";
import { parseSort, sortRows } from "@/src/lib/sort";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

const TASK_COLUMNS = [
  "task",
  "trials",
  "done",
  "errors",
  "reward",
  "cost",
  "turns",
] as const;
type TaskColumn = (typeof TASK_COLUMNS)[number];

function taskValue(c: TaskCell, key: TaskColumn) {
  switch (key) {
    case "task":
      return c.task_name;
    case "trials":
      return c.n;
    case "done":
      return c.scored;
    case "errors":
      return c.errors;
    case "reward":
      return c.mean_reward;
    case "cost":
      return c.mean_cost_cents;
    case "turns":
      return c.mean_turns;
  }
}

export default async function SuitePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sort = parseSort(await searchParams, TASK_COLUMNS, {
    key: "task",
    dir: "asc",
  });
  const data = await loadSuite(id);
  if (!data) notFound();
  const { suite, jobs, trials } = data;

  const taskOf = new Map(jobs.map((j) => [j.id, j.taskName] as const));
  const cells = taskCells(
    trials.map((t) => ({ ...t, task_name: taskOf.get(t.jobId) ?? t.jobId }))
  );
  const sortedCells = sortRows(cells, sort, taskValue);
  const totals = suiteTotals(cells);
  const trialsByJob = groupBy(trials, (t) => t.jobId);
  const gh = githubRunUrl(suite);

  return (
    <>
      <nav aria-label="breadcrumb">
        <ol className="breadcrumb">
          <li className="breadcrumb-item">
            <Link href="/suites">Suites</Link>
          </li>
          <li
            className="breadcrumb-item active font-monospace"
            aria-current="page"
          >
            {suite.id}
          </li>
        </ol>
      </nav>
      <h1>
        {suite.name}{" "}
        <span className="text-body-secondary font-monospace">{suite.id}</span>
      </h1>
      <dl className="row row-cols-1 row-cols-md-2 g-1 mb-4">
        <div className="col">
          <dl className="row mb-0">
            <dt className="col-4 col-md-3 text-body-secondary fw-normal">
              driver
            </dt>
            <dd className="col-8 col-md-9 font-monospace">
              {suite.driverName}
            </dd>
          </dl>
        </div>
        <div className="col">
          <dl className="row mb-0">
            <dt className="col-4 col-md-3 text-body-secondary fw-normal">
              target
            </dt>
            <dd className="col-8 col-md-9">
              {suite.targetName}{" "}
              <span className="text-body-secondary font-monospace">
                {targetSpec(suite)}
              </span>
            </dd>
          </dl>
        </div>
        <div className="col">
          <dl className="row mb-0">
            <dt className="col-4 col-md-3 text-body-secondary fw-normal">
              count
            </dt>
            <dd className="col-8 col-md-9 font-monospace">
              {suite.count} per task
            </dd>
          </dl>
        </div>
        <div className="col">
          <dl className="row mb-0">
            <dt className="col-4 col-md-3 text-body-secondary fw-normal">
              started
            </dt>
            <dd className="col-8 col-md-9 font-monospace">
              {when(suite.startedAt)} ·{" "}
              {suite.finishedAt
                ? `finished in ${elapsed(suite.startedAt, suite.finishedAt)}`
                : "running"}
            </dd>
          </dl>
        </div>
        <div className="col">
          <dl className="row mb-0">
            <dt className="col-4 col-md-3 text-body-secondary fw-normal">
              harbor
            </dt>
            <dd className="col-8 col-md-9 font-monospace">{suite.harborEnv}</dd>
          </dl>
        </div>
        <div className="col">
          <dl className="row mb-0">
            <dt className="col-4 col-md-3 text-body-secondary fw-normal">
              git
            </dt>
            <dd className="col-8 col-md-9 font-monospace">
              {shortSha(suite.gitSha)}
            </dd>
          </dl>
        </div>
        <div className="col">
          <dl className="row mb-0">
            <dt className="col-4 col-md-3 text-body-secondary fw-normal">
              run
            </dt>
            <dd className="col-8 col-md-9">
              {gh ? (
                <a href={gh}>
                  {suite.githubRepository} run {suite.githubRunId}
                  {suite.githubRunAttempt && suite.githubRunAttempt > 1
                    ? ` attempt ${suite.githubRunAttempt}`
                    : ""}
                </a>
              ) : (
                <span className="text-body-secondary">local</span>
              )}
            </dd>
          </dl>
        </div>
        <div className="col">
          <dl className="row mb-0">
            <dt className="col-4 col-md-3 text-body-secondary fw-normal">
              suite file
            </dt>
            <dd className="col-8 col-md-9 font-monospace">{suite.keyFile}</dd>
          </dl>
        </div>
        <div className="col">
          <dl className="row mb-0">
            <dt className="col-4 col-md-3 text-body-secondary fw-normal">
              log dir
            </dt>
            <dd className="col-8 col-md-9 font-monospace">{suite.logDir}</dd>
          </dl>
        </div>
      </dl>

      <h2 className="h4 mt-4">Tasks: {cells.length}</h2>
      <div className="table-responsive">
        <table className="table table-sm table-striped table-hover align-middle mb-0">
          <thead>
            <tr>
              {TASK_COLUMNS.map((col) => (
                <SortTh
                  key={col}
                  path={`/suites/${suite.id}`}
                  current={sort}
                  column={col}
                  label={col}
                  numeric={col !== "task"}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            <TotalsRow totals={totals} />
            {sortedCells.map((c) => (
              <tr key={c.task_name}>
                <td className="font-monospace">
                  <a href={`#task-${c.task_name}`}>{c.task_name}</a>
                </td>
                <td className="text-end font-monospace">{c.n}</td>
                <td className="text-end font-monospace">{c.scored}</td>
                <td
                  className={`text-end font-monospace${c.errors > 0 ? " text-danger" : ""}`}
                >
                  {c.errors}
                </td>
                <td className="text-end font-monospace">
                  {reward(c.mean_reward)}
                </td>
                <td className="text-end font-monospace">
                  {cents(c.mean_cost_cents)}
                </td>
                <td className="text-end font-monospace">
                  {c.mean_turns == null ? "–" : c.mean_turns.toFixed(1)}
                </td>
              </tr>
            ))}
            <TotalsRow totals={totals} />
          </tbody>
        </table>
      </div>

      <h2 className="h4 mt-4">Jobs</h2>
      {jobs.map((j) => (
        <section className="card mb-3" key={j.id} id={`task-${j.taskName}`}>
          <div className="card-body">
            <h3 className="h5">
              <span className="font-monospace">{j.taskName}</span>{" "}
              <span className="text-body-secondary font-monospace">{j.id}</span>{" "}
              <span
                className={
                  j.status === "done"
                    ? "badge text-bg-success"
                    : j.status === "failed" || j.status === "timed_out"
                      ? "badge text-bg-danger"
                      : "badge text-bg-secondary"
                }
              >
                {j.status}
              </span>{" "}
              <JobScore trials={trialsByJob.get(j.id) ?? []} />
            </h3>
            <p className="text-body-secondary font-monospace">
              {j.runner} · count {j.count} · concurrency {j.concurrency} ·{" "}
              {j.startedAt
                ? `${when(j.startedAt)} · ${elapsed(j.startedAt, j.finishedAt)}`
                : "not started"}
              {j.exitCode != null && j.exitCode !== 0
                ? ` · exit ${j.exitCode}`
                : ""}
            </p>
            {j.error ? (
              <div className="alert alert-danger py-2 small mb-2">
                {truncate(j.error, 400)}
              </div>
            ) : null}
            <TrialTable trials={trialsByJob.get(j.id) ?? []} />
          </div>
        </section>
      ))}
    </>
  );
}

/** The job's own score and cost: means over its done trials. */
function JobScore({ trials }: { trials: TrialRow[] }) {
  const cell = cellFor("job", trials);
  return (
    <span className="text-body-secondary font-monospace fs-6 fw-normal">
      score {reward(cell.mean_reward)} · cost {cents(cell.mean_cost_cents)} ·{" "}
      {cell.scored}/{cell.n} done
    </span>
  );
}

function TotalsRow({ totals }: { totals: TaskCell }) {
  return (
    <tr className="table-active fw-semibold">
      <td>ALL</td>
      <td className="text-end font-monospace">{totals.n}</td>
      <td className="text-end font-monospace">{totals.scored}</td>
      <td
        className={`text-end font-monospace${totals.errors > 0 ? " text-danger" : ""}`}
      >
        {totals.errors}
      </td>
      <td className="text-end font-monospace">{reward(totals.mean_reward)}</td>
      <td className="text-end font-monospace">
        {cents(totals.mean_cost_cents)}
      </td>
      <td className="text-end font-monospace">
        {totals.mean_turns == null ? "–" : totals.mean_turns.toFixed(1)}
      </td>
    </tr>
  );
}

function TrialTable({ trials }: { trials: TrialRow[] }) {
  if (trials.length === 0)
    return (
      <div className="alert alert-secondary py-2 mb-0">No trials recorded.</div>
    );
  return (
    <div className="table-responsive">
      <table className="table table-sm table-striped table-hover align-middle mb-0">
        <thead>
          <tr>
            <th>trial</th>
            <th className="text-end font-monospace">reward</th>
            <th>stop</th>
            <th className="text-end font-monospace">turns</th>
            <th className="text-end font-monospace">tools</th>
            <th className="text-end font-monospace">in</th>
            <th className="text-end font-monospace">cached</th>
            <th className="text-end font-monospace">out</th>
            <th className="text-end font-monospace">calls</th>
            <th className="text-end font-monospace">cost</th>
            <th className="text-end font-monospace">duration</th>
            <th>error</th>
          </tr>
        </thead>
        <tbody>
          {trials.map((t) => (
            <TrialRow key={t.id} trial={t} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrialRow({ trial }: { trial: TrialRow }) {
  return (
    <tr>
      <td className="font-monospace">
        <Link href={`/trials/${trial.id}`}>{trial.trialName}</Link>
      </td>
      <td
        className={`text-end font-monospace${trial.reward === 1 ? " text-success" : trial.reward === 0 ? " text-danger" : ""}`}
      >
        {reward(trial.reward)}
      </td>
      <td className="font-monospace">{trial.stopReason ?? "–"}</td>
      <td className="text-end font-monospace">{count(trial.turns)}</td>
      <td className="text-end font-monospace">{count(trial.envToolCalls)}</td>
      <td className="text-end font-monospace">{tokens(trial.inputTokens)}</td>
      <td className="text-end font-monospace">
        {tokens(trial.cachedInputTokens)}
      </td>
      <td className="text-end font-monospace">{tokens(trial.outputTokens)}</td>
      <td className="text-end font-monospace">{trial.modelCalls}</td>
      <td className="text-end font-monospace">{cents(trial.costCents)}</td>
      <td className="text-end font-monospace">{duration(trial.durationMs)}</td>
      <td className="error text-danger">{truncate(trial.error)}</td>
    </tr>
  );
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k) ?? [];
    list.push(item);
    out.set(k, list);
  }
  return out;
}
