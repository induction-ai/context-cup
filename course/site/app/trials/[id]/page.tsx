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
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function TrialPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await loadTrial(id);
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
            <a href={`/suites/${suite.id}#task-${job.taskName}`}>
              {job.taskName}
            </a>
          </li>
          <li
            className="breadcrumb-item active font-monospace"
            aria-current="page"
          >
            {trial.trialName}
          </li>
        </ol>
      </nav>
      <h1 className="h3 mb-3">
        {trial.trialName}{" "}
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
          {suite.driverName}
        </Fact>
        <Fact label="target">
          {suite.targetName}{" "}
          <span className="text-body-secondary font-monospace">
            {targetSpec(suite)}
          </span>
        </Fact>
        <Fact label="task" mono>
          {job.taskName} · {job.runner}
        </Fact>
        <Fact label="reward">
          <span className={`font-monospace ${rewardClass}`}>
            {reward(trial.reward)}
          </span>
          {trial.scoreReason ? (
            <span className="text-body-secondary"> · {trial.scoreReason}</span>
          ) : null}
        </Fact>
        <Fact label="stop reason" mono>
          {trial.stopReason ?? "–"}
        </Fact>
        <Fact label="turns" mono>
          {count(trial.turns)} turns · {count(trial.envToolCalls)} tool calls ·{" "}
          {trial.modelCalls} model calls
        </Fact>
        <Fact label="duration" mono>
          {duration(trial.durationMs)}
        </Fact>
        <Fact label="tokens" mono>
          in {tokens(trial.inputTokens)} · cached{" "}
          {tokens(trial.cachedInputTokens)} · cache write{" "}
          {tokens(trial.cacheWriteInputTokens)} · out{" "}
          {tokens(trial.outputTokens)} · reasoning{" "}
          {tokens(trial.reasoningOutputTokens)}
        </Fact>
        <Fact label="cost" mono>
          {cents(trial.costCents)}
        </Fact>
        <Fact label="job" mono>
          <Link href={`/suites/${suite.id}`}>{job.id}</Link> · {job.status}
          {job.startedAt
            ? ` · ${when(job.startedAt)} · ${elapsed(job.startedAt, job.finishedAt)}`
            : ""}
        </Fact>
        <Fact label="recorded" mono>
          {when(trial.createdAt)}
        </Fact>
        <Fact label="trial dir" mono>
          {trial.trialDir}
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
  const sum = (pick: (c: ModelCallRow) => number | null) =>
    calls.reduce((acc, c) => acc + (pick(c) ?? 0), 0);
  const priced = calls.every((c) => c.costCents != null);
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
            <tr key={c.id}>
              <td className="font-monospace">{c.turnId}</td>
              <td className="text-end font-monospace">{c.sequence}</td>
              <td>{c.purpose ?? "turn"}</td>
              <td className="font-monospace">{c.model}</td>
              <td className="font-monospace">{c.wire}</td>
              <td className="font-monospace">{c.host}</td>
              <td className="text-end font-monospace">
                {tokens(c.inputTokens)}
              </td>
              <td className="text-end font-monospace">
                {tokens(c.cachedInputTokens)}
              </td>
              <td className="text-end font-monospace">
                {tokens(c.cacheWriteInputTokens)}
              </td>
              <td className="text-end font-monospace">
                {tokens(c.outputTokens)}
              </td>
              <td className="text-end font-monospace">
                {tokens(c.reasoningOutputTokens)}
              </td>
              <td className="text-end font-monospace">{cents(c.costCents)}</td>
              <td className="text-end font-monospace">
                {duration(c.durationMs)}
              </td>
              <td className="font-monospace">{c.serviceTier ?? "–"}</td>
            </tr>
          ))}
          <tr className="table-active fw-semibold">
            <td colSpan={6}>ALL</td>
            <td className="text-end font-monospace">
              {tokens(sum((c) => c.inputTokens))}
            </td>
            <td className="text-end font-monospace">
              {tokens(sum((c) => c.cachedInputTokens))}
            </td>
            <td className="text-end font-monospace">
              {tokens(sum((c) => c.cacheWriteInputTokens))}
            </td>
            <td className="text-end font-monospace">
              {tokens(sum((c) => c.outputTokens))}
            </td>
            <td className="text-end font-monospace">
              {tokens(sum((c) => c.reasoningOutputTokens))}
            </td>
            <td className="text-end font-monospace">
              {priced ? cents(sum((c) => c.costCents)) : "–"}
            </td>
            <td className="text-end font-monospace">
              {duration(sum((c) => c.durationMs))}
            </td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
