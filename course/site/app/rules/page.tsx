import { dollars, reward } from "@/src/lib/format";
import { BENCHMARK_SITES, DOCS, REPO_URL } from "@/src/lib/links";
import {
  BASELINES,
  BENCHMARK_SUITES,
  BENCHMARK_TASKS,
  ELIGIBILITY,
  REFERENCE_TARGET,
  type BenchmarkSuite,
} from "@/src/lib/standings";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Rules",
  description:
    "How Context Cup is scored and won: the benchmarks, the baselines, and what a driver may call.",
};

/** Each benchmark suite's name for people. */
const BENCHMARK_NAMES: Record<BenchmarkSuite, string> = {
  tau_banking: "tau3",
  toolathlon: "Toolathlon",
};

/** README "Scoring", "Rules", "Winning", and "Entering" for people who
 *  arrive at the site. The numbers come from `standings.ts`, so the page
 *  and the leaderboard can't disagree; the prose follows the README. */
export default function Rules() {
  return (
    <>
      <h1 className="h3 mb-3">Rules</h1>
      <p>
        Each <strong>driver</strong> manages an agent’s context as it grows
        (what to keep, compress, drop, or retrieve), or is a whole agent of its
        own. Every driver runs the same benchmark tasks. To win the cup, match
        the baseline’s score for less money on both benchmarks. Of the drivers
        that do, the one that spends the least wins. You develop a driver on the
        practice suites and enter it with a pull request; the competition runs
        the full benchmarks on every entry (see <a href="#entering">Entering</a>
        ).
      </p>

      <Section id="benchmarks" title="The benchmarks">
        <div className="table-responsive">
          <table className="table table-sm align-middle">
            <thead>
              <tr>
                <th>Benchmark</th>
                <th>Leaderboard</th>
                <th className="text-end">Tasks</th>
                <th className="text-end">Baseline score</th>
                <th className="text-end">Baseline $ / run</th>
              </tr>
            </thead>
            <tbody>
              {BENCHMARK_SUITES.map((name) => (
                <tr key={name}>
                  <td>
                    <a
                      href={BENCHMARK_SITES[name]}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {BENCHMARK_NAMES[name]}
                    </a>
                  </td>
                  <td className="font-monospace">
                    <Link href={`/leaderboard/${name}`}>{name}</Link>
                  </td>
                  <td className="text-end font-monospace">
                    {BENCHMARK_TASKS[name].length}
                  </td>
                  <td className="text-end font-monospace">
                    {reward(BASELINES[name].score)}
                  </td>
                  <td className="text-end font-monospace">
                    {dollars(BASELINES[name].run_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          The competition runs these two suites on every entry. The full{" "}
          <span className="font-monospace">toolathlon</span> suite needs
          credentials for outside services, so for developing a driver there are
          practice suites, which never count toward the standings:
        </p>
        <ul>
          <li>
            <span className="font-monospace">smoke_tau</span> and{" "}
            <span className="font-monospace">smoke_toolathlon</span>: one task
            each, to check that a driver runs end to end.
          </li>
          <li>
            <span className="font-monospace">toolathlon_local</span>: the
            Toolathlon tasks that need no credentials, for an easier-to-access
            read on a driver’s score and cost.
          </li>
        </ul>
      </Section>

      <Section id="scoring" title="Scoring">
        <p>
          A trial is one attempt at one task. It is considered valid when it
          reaches a verdict without an error. Errored or unfinished trials are
          left out, not counted as zero. Every task runs several times, and
          needs at least {ELIGIBILITY.min_done} valid trials to count, so no
          score rests on a single attempt.
        </p>
        <ul>
          <li>
            A task’s score is the mean reward over its valid trials, and its
            cost the mean price of those trials.
          </li>
          <li>A suite’s score and cost are the means of its tasks’ values.</li>
        </ul>
        <p>
          Every model call a driver makes is in its cost with the model(s) it
          used.
        </p>
      </Section>

      <Section id="fair-play" title="Fair play">
        <ul>
          <li>
            <strong>Models</strong>: a driver may call any model from the
            target’s provider, as often as it likes. At{" "}
            <span className="font-monospace">{REFERENCE_TARGET}</span> that is
            any OpenAI model. The target is the default, not a requirement: a
            cheaper OpenAI model for summaries is fair game, an Anthropic or
            Gemini model is not.
          </li>
          <li>
            <strong>One endpoint</strong>: every model call goes to the base URL
            the driver is given for that provider, and nowhere else.
          </li>
          <li>
            <strong>No other external calls</strong>: no web search, no outside
            APIs or services, no downloads while a task runs. Installing the
            driver’s own dependencies during setup is fine. After that, the
            model endpoint and the task’s own tools are the only ways out.
          </li>
          <li>
            <strong>No overfitting</strong>: submissions are reviewed for
            anything that looks like overfitting to these benchmarks. Submit a
            generic context-management solution.
          </li>
        </ul>
      </Section>

      <Section id="winning" title="Winning">
        <p>
          The cup goes to one driver: the leader of the{" "}
          <Link href="/leaderboard">combined leaderboard</Link>. To lead it, a
          driver beats the baseline on both benchmarks, and does it for the
          least money.
        </p>

        <h3 className="h5 mt-4 mb-3">Qualifying</h3>
        <p>
          Each benchmark is judged on one suite at the reference target (
          <span className="font-monospace">{REFERENCE_TARGET}</span>) against a
          fixed baseline: the score and cost in the table under{" "}
          <a href="#benchmarks">The benchmarks</a>. A driver qualifies for the
          cup when, on every benchmark, both hold:
        </p>
        <ul>
          <li>
            <strong>Score</strong>: rounded to two decimals, at least the
            baseline’s.
          </li>
          <li>
            <strong>Cost</strong>: a full benchmark run, every task once (the
            mean cost per task times the suite’s task count), costs less than
            the baseline’s.
          </li>
        </ul>
        <p>
          Matching the baseline’s score without spending less wins nothing, and
          neither does beating one benchmark alone.
        </p>
        <p>
          Each driver stands on one run per benchmark: the competition’s most
          recent run of the suite with it, at the reference target, that is
          finished, covers every task in the suite file (a run narrowed with{" "}
          <span className="font-monospace">--task</span> is not a full run), and
          has at least {ELIGIBILITY.min_done} valid trials in each, retry passes
          included. Earlier runs, and runs that miss any of these, do not count.
          Neither does a smoke suite, or any suite but the two above.
        </p>

        <h3 className="h5 mt-4 mb-3">The winner</h3>
        <p>
          Of the qualifiers, the one that spends least against the baselines
          wins. That is measured across both benchmarks as the geometric mean of
          its cost ratios, each benchmark’s run cost over the baseline’s:
        </p>
        <pre className="border bg-body-tertiary p-3">
          {`√( ${BENCHMARK_SUITES.map(
            (name) => `(${name} cost ÷ ${dollars(BASELINES[name].run_cents)})`
          ).join(" × ")} )`}
        </pre>
        <p>
          Lowest wins. A benchmark counts for as much however dear its runs: the
          baselines’ costs are constants in that product, so they drop out of
          the order, and halving a cost counts the same on either benchmark. A
          big saving on one can outweigh an even saving on both. At half the
          baseline’s cost on {BENCHMARK_NAMES.tau_banking} and 95% of it on{" "}
          {BENCHMARK_NAMES.toolathlon}, a driver comes to √(0.5 × 0.95) ≈ 0.69,
          and beats one at 70% on both (0.70). With no qualifier, no one leads.
        </p>

        <h3 className="h5 mt-4 mb-3">The standings</h3>
        <p>The combined leaderboard ranks every driver, in this order:</p>
        <ol>
          <li>Qualifiers, lowest mean first. The first is the leader.</li>
          <li>
            Drivers that reach both baselines’ scores but not both costs, lowest
            mean first.
          </li>
          <li>
            Drivers under a baseline’s score, by their worse score ratio (score
            over the baseline’s), best first.
          </li>
          <li>Drivers without a standing run on both benchmarks.</li>
        </ol>
        <p>
          Each benchmark also has its own leaderboard, to see where a driver
          stands on one. It applies the same bar to that benchmark alone and
          ranks qualifiers cheapest first, then those that reach the score but
          cost as much or more (cheapest first), then those under it (best score
          first), then those with nothing scored. Leading one wins nothing on
          its own.
        </p>
      </Section>

      <Section id="entering" title="Entering">
        <p>
          A driver is a package under{" "}
          <span className="font-monospace">drivers/</span> in the{" "}
          <a href={REPO_URL}>repo</a>. The{" "}
          <a href={DOCS.drivers}>driver guide</a> covers writing one: pick a
          lane, copy its base driver, and edit. While developing, run it on the
          smoke suites, <span className="font-monospace">tau_banking</span>, and{" "}
          <span className="font-monospace">toolathlon_local</span>, which needs
          no credentials:
        </p>
        <pre className="border bg-body-tertiary p-3">
          {"bin/suite tau_banking --driver <your_driver>\n" +
            "bin/suite toolathlon_local --driver <your_driver>"}
        </pre>
        <p>
          These run at the reference target, 3 attempts per task. The full{" "}
          <span className="font-monospace">toolathlon</span> suite needs
          credentials for outside services, so the competition runs the
          benchmarks: to enter, open a{" "}
          <a href={`${REPO_URL}/pulls`}>pull request</a> adding your driver
          under <span className="font-monospace">drivers/</span>, and we run
          both full benchmark suites with it for the standings. The{" "}
          <a href={DOCS.entering}>README</a> has the rest.
        </p>
      </Section>
    </>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mt-5">
      <h2 className="h4 mb-3">{title}</h2>
      {children}
    </section>
  );
}
