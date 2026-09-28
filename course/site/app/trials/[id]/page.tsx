import {
  cents,
  count,
  duration,
  elapsed,
  reward,
  targetSpec,
  tokens,
  when,
} from "@/src/lib/format";
import { loadTrial, type ModelCallRow } from "@/src/lib/queries";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

export const dynamic = "force-dynamic";

// One query per request, shared by the title and the page.
const trialById = cache(loadTrial);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const data = await trialById((await params).id);
  if (!data) return {};
  const { trial, suite } = data;
  return {
    title: `Trial - ${trial.trial_name}`,
    description: `A trial of ${suite.driver_name} on ${suite.name}: its outcome and every model call.`,
  };
}

export default async function TrialPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await trialById(id);
  if (!data) notFound();
  const { trial, job, suite, calls } = data;
  const rewardClass =
    trial.reward === 1
      ? "text-success"
      : trial.reward === 0
        ? "text-danger"
        : "";

  return (
    <>
      <nav aria-label="breadcrumb">
        <ol className="breadcrumb">
          <li className="breadcrumb-item">
            <Link href="/suites">Suites</Link>
          </li>
          <li className="breadcrumb-item font-monospace">
            <Link href={`/suites/${suite.id}`}>{suite.id}</Link>
          </li>
          <li className="breadcrumb-item font-monospace">
            <a href={`/suites/${suite.id}#task-${job.task_name}`}>
              {job.task_name}
            </a>
          </li>
          <li
            className="breadcrumb-item active font-monospace"
            aria-current="page"
          >
            {trial.trial_name}
          </li>
        </ol>
      </nav>
      <h1 className="h3 mb-3">
        {trial.trial_name}{" "}
        <span className={`font-monospace ${rewardClass}`}>
          {reward(trial.reward)}
        </span>
      </h1>

      <div className="row row-cols-1 row-cols-md-2 g-1 mb-4">
        <Fact label="suite">
          <Link href={`/suites/${suite.id}`} className="font-monospace">
            {suite.name} {suite.id}
          </Link>
        </Fact>
        <Fact label="driver" mono>
          {suite.driver_name}
        </Fact>
        <Fact label="target">
          {suite.target_name}{" "}
          <span className="text-body-secondary font-monospace">
            {targetSpec(suite)}
          </span>
        </Fact>
        <Fact label="task" mono>
          {job.task_name} · {job.runner}
        </Fact>
        <Fact label="reward">
          <span className={`font-monospace ${rewardClass}`}>
            {reward(trial.reward)}
          </span>
          {trial.score_reason ? (
            <span className="text-body-secondary"> · {trial.score_reason}</span>
          ) : null}
        </Fact>
        <Fact label="stop reason" mono>
          {trial.stop_reason ?? "–"}
        </Fact>
        <Fact label="turns" mono>
          {count(trial.turns)} turns · {count(trial.env_tool_calls)} tool calls
          · {trial.model_calls} model calls
        </Fact>
        <Fact label="duration" mono>
          {duration(trial.duration_ms)}
        </Fact>
        <Fact label="tokens" mono>
          in {tokens(trial.input_tokens)} · cached{" "}
          {tokens(trial.cached_input_tokens)} · cache write{" "}
          {tokens(trial.cache_write_input_tokens)} · out{" "}
          {tokens(trial.output_tokens)} · reasoning{" "}
          {tokens(trial.reasoning_output_tokens)}
        </Fact>
        <Fact label="cost" mono>
          {cents(trial.cost_cents)}
        </Fact>
        <Fact label="job" mono>
          <Link href={`/suites/${suite.id}`}>{job.id}</Link> · {job.status}
          {job.started_at
            ? ` · ${when(job.started_at)} · ${elapsed(job.started_at, job.finished_at)}`
            : ""}
        </Fact>
        <Fact label="recorded" mono>
          {when(trial.created_at)}
        </Fact>
        <Fact label="trial dir" mono>
          {trial.trial_dir}
        </Fact>
      </div>

      {trial.error ? (
        <>
          <h2 className="h5">Error</h2>
          <div className="alert alert-danger mb-4">
            <pre className="mb-0 small">{trial.error}</pre>
          </div>
        </>
      ) : null}

      <h2 className="h4 mt-4">Model calls</h2>
      {calls.length === 0 ? (
        <div className="alert alert-secondary py-2">
          No model calls recorded.
        </div>
      ) : (
        <CallTable calls={calls} />
      )}
    </>
  );
}

function Fact({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="col">
      <dl className="row mb-0">
        <dt className="col-4 col-md-3 text-body-secondary fw-normal">
          {label}
        </dt>
        <dd className={`col-8 col-md-9${mono ? " font-monospace" : ""}`}>
          {children}
        </dd>
      </dl>
    </div>
  );
}

function CallTable({ calls }: { calls: ModelCallRow[] }) {
  // Calls from a discarded attempt (an empty reply the runner re-asked) are
  // shown but left out of the totals, as they are out of the trial's cost.
  const counted = calls.filter((c) => !c.discarded);
  const discarded = calls.filter((c) => c.discarded);
  const sum = (
    pick: (c: ModelCallRow) => number | null,
    of: ModelCallRow[] = counted
  ) => of.reduce((acc, c) => acc + (pick(c) ?? 0), 0);
  const priced = counted.every((c) => c.cost_cents != null);
  return (
    <div className="table-responsive">
      <table className="table table-sm table-striped table-hover align-middle mb-0">
        <thead>
          <tr>
            <th>turn</th>
            <th className="text-end font-monospace">#</th>
            <th>purpose</th>
            <th>model</th>
            <th>wire</th>
            <th>host</th>
            <th className="text-end font-monospace">in</th>
            <th className="text-end font-monospace">cached</th>
            <th className="text-end font-monospace">cache write</th>
            <th className="text-end font-monospace">out</th>
            <th className="text-end font-monospace">reasoning</th>
            <th className="text-end font-monospace">cost</th>
            <th className="text-end font-monospace">duration</th>
            <th>tier</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr
              key={c.id}
              className={c.discarded ? "text-body-secondary" : undefined}
            >
              <td className="font-monospace">
                {c.turn_id}
                {c.discarded ? (
                  <span className="badge text-bg-secondary ms-2">
                    discarded
                  </span>
                ) : null}
              </td>
              <td className="text-end font-monospace">{c.sequence}</td>
              <td>{c.purpose ?? "turn"}</td>
              <td className="font-monospace">{c.model}</td>
              <td className="font-monospace">{c.wire}</td>
              <td className="font-monospace">{c.host}</td>
              <td className="text-end font-monospace">
                {tokens(c.input_tokens)}
              </td>
              <td className="text-end font-monospace">
                {tokens(c.cached_input_tokens)}
              </td>
              <td className="text-end font-monospace">
                {tokens(c.cache_write_input_tokens)}
              </td>
              <td className="text-end font-monospace">
                {tokens(c.output_tokens)}
              </td>
              <td className="text-end font-monospace">
                {tokens(c.reasoning_output_tokens)}
              </td>
              <td className="text-end font-monospace">{cents(c.cost_cents)}</td>
              <td className="text-end font-monospace">
                {duration(c.duration_ms)}
              </td>
              <td className="font-monospace">{c.service_tier ?? "–"}</td>
            </tr>
          ))}
          <tr className="table-active fw-semibold">
            <td colSpan={6}>ALL</td>
            <td className="text-end font-monospace">
              {tokens(sum((c) => c.input_tokens))}
            </td>
            <td className="text-end font-monospace">
              {tokens(sum((c) => c.cached_input_tokens))}
            </td>
            <td className="text-end font-monospace">
              {tokens(sum((c) => c.cache_write_input_tokens))}
            </td>
            <td className="text-end font-monospace">
              {tokens(sum((c) => c.output_tokens))}
            </td>
            <td className="text-end font-monospace">
              {tokens(sum((c) => c.reasoning_output_tokens))}
            </td>
            <td className="text-end font-monospace">
              {priced ? cents(sum((c) => c.cost_cents)) : "–"}
            </td>
            <td className="text-end font-monospace">
              {duration(sum((c) => c.duration_ms))}
            </td>
            <td />
          </tr>
        </tbody>
      </table>
      {discarded.length > 0 ? (
        <p className="text-body-secondary small mt-2 mb-0">
          {discarded.length} call{discarded.length === 1 ? "" : "s"} from
          discarded attempts (empty replies re-asked) are not in the totals or
          the trial&rsquo;s cost; they spent{" "}
          {discarded.every((c) => c.cost_cents != null)
            ? cents(sum((c) => c.cost_cents, discarded))
            : "an unpriced amount"}
          .
        </p>
      ) : null}
    </div>
  );
}
