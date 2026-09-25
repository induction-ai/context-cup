import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  getCurrentTransaction,
  withTransaction,
} from "@context-cup/db/connection.js";
import {
  job,
  modelCall,
  suite,
  trial,
  type JobStatus,
} from "@context-cup/db/schema.js";
import {
  zProvider,
  zWire,
  type Provider,
} from "@context-cup/shared/provider.js";
import { eq } from "drizzle-orm";
import z from "zod";
import type { SuiteRun } from "./expand.ts";
import { newId } from "./ids.ts";
import { callCostCents, type CallUsage } from "./pricing.ts";
import type { JobResult } from "./scheduler.ts";

// ---------------------------------------------------------------------------
// Files a harbor trial leaves behind (see docs/protocol.md, "Files the runner
// writes per trial", and harbor's TrialResult model).
// ---------------------------------------------------------------------------

const zTrialResult = z.object({
  trial_name: z.string(),
  verifier_result: z
    .object({ rewards: z.record(z.string(), z.number()).nullable().optional() })
    .nullable()
    .optional(),
  agent_result: z
    .object({
      n_input_tokens: z.number().nullable().optional(),
      n_cache_tokens: z.number().nullable().optional(),
      n_output_tokens: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  exception_info: z
    .object({ exception_type: z.string(), exception_message: z.string() })
    .nullable()
    .optional(),
  agent_execution: z
    .object({
      started_at: z.string().nullable().optional(),
      finished_at: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
});

const zUsage = z.object({
  input: z.number().default(0),
  cached_input: z.number().default(0),
  cache_write_input: z.number().default(0),
  output: z.number().default(0),
  reasoning_output: z.number().default(0),
});

/** One line of the proxy's calls.jsonl (course/proxy, records.ts). */
const zCall = z.object({
  trial_id: z.string(),
  turn_id: z.string().nullable(),
  sequence: z.number().int(),
  purpose: z.string().default("turn"),
  provider: zProvider,
  host: z.string().default(""),
  /** Null when neither request nor response named a model. */
  model: z.string().nullable(),
  wire: zWire,
  usage: zUsage.nullable(),
  duration_ms: z.number().nullable().optional(),
  status: z.number().int().nullable().optional(),
  service_tier: z.string().nullable().optional(),
  error: z.string().optional(),
});
export type CallRecord = z.infer<typeof zCall>;

const zSummary = z.object({
  stop_reason: z.string().optional(),
  turns: z.number().int().optional(),
  env_tool_calls: z.number().int().optional(),
  /** The runner writes the error list; older fixtures a count. */
  errors: z.union([z.number().int(), z.array(z.unknown())]).optional(),
});

/** Turn ids of attempts the runner discarded (empty replies). */
function discardedTurns(errors: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(errors)) return out;
  for (const e of errors) {
    if (e && typeof e === "object") {
      const { turn_id, discarded } = e as {
        turn_id?: unknown;
        discarded?: unknown;
      };
      if (discarded === true && typeof turn_id === "string") out.add(turn_id);
    }
  }
  return out;
}

const zJobResult = z.object({
  stats: z
    .object({
      evals: z
        .record(
          z.string(),
          z.object({
            exception_stats: z
              .record(z.string(), z.array(z.string()))
              .default({}),
          })
        )
        .default({}),
    })
    .optional(),
});

export type PricedCall = {
  sequence: number;
  turn_id: string | null;
  purpose: string;
  provider: Provider;
  host: string;
  /** `?` when the proxy could not name the model. */
  model: string;
  wire: CallRecord["wire"];
  usage: CallUsage & { reasoning_output: number };
  duration_ms: number | null;
  service_tier: string | null;
  /** Null when the model is unknown to the pricing table or unnamed. */
  cost_cents: number | null;
  /** From a discarded attempt: stored, but outside the trial's usage and cost. */
  discarded: boolean;
};

export type ParsedTrial = {
  trial_name: string;
  trial_dir: string;
  reward: number | null;
  score_reason: string | null;
  error: string | null;
  stop_reason: string | null;
  turns: number | null;
  env_tool_calls: number | null;
  duration_ms: number | null;
  totals: CallUsage & { reasoning_output: number };
  calls: PricedCall[];
  /** Null when any counted call's model is unpriced. */
  cost_cents: number | null;
};

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Where a trial's proxy, running in its container, wrote its calls. */
export function trialCallLog(trial_dir: string): string {
  return path.join(trial_dir, "agent", "calls.jsonl");
}

/** Every call a proxy log recorded, in order. Each trial has its own proxy,
 *  so every call in the file is that trial's to pay for, whatever trial id
 *  its URL carried. A missing file means no calls were made. */
export function readCallLog(file: string): CallRecord[] {
  if (!existsSync(file)) return [];
  const calls: CallRecord[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  const last = lines.findLastIndex((line) => line.trim());
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      // A proxy killed mid-write leaves a partial last line; that call was
      // never answered. Anywhere else, the file is corrupt.
      if (index === last) break;
      throw new Error(`${file}:${index + 1}: ${String(err)}`);
    }
    const parsed = zCall.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `${file}:${index + 1}: ${parsed.error.issues.map((i) => i.message).join("; ")}`
      );
    }
    calls.push(parsed.data);
  }
  return calls.sort((a, b) => a.sequence - b.sequence);
}

const ZERO_USAGE = {
  input: 0,
  cached_input: 0,
  cache_write_input: 0,
  output: 0,
  reasoning_output: 0,
};

function priceCall(call: CallRecord, discarded = false): PricedCall {
  const usage = call.usage ?? ZERO_USAGE;
  return {
    sequence: call.sequence,
    turn_id: call.turn_id,
    purpose: call.purpose,
    provider: call.provider,
    host: call.host,
    model: call.model ?? "?",
    wire: call.wire,
    usage,
    duration_ms: call.duration_ms ?? null,
    service_tier: call.service_tier ?? null,
    // A call the provider rejected (4xx/5xx) billed nothing, so it costs 0
    // and must not leave the trial unpriced; a successful call with no model
    // or no usage is genuinely unpriced.
    cost_cents:
      call.status != null && call.status >= 400 && !call.usage
        ? 0
        : call.model && call.usage
          ? callCostCents(call.model, usage, call.service_tier)
          : null,
    discarded,
  };
}

function readReward(
  trial_dir: string,
  result: z.infer<typeof zTrialResult>
): number | null {
  const rewardFile = path.join(trial_dir, "verifier", "reward.txt");
  if (existsSync(rewardFile)) {
    const value = Number(readFileSync(rewardFile, "utf8").trim());
    if (Number.isFinite(value)) return value;
  }
  // A verifier may report several named rewards; every benchmark here reports
  // one, and "reward" is the name harbor gives it.
  const rewards = result.verifier_result?.rewards;
  if (!rewards) return null;
  const reward = rewards.reward ?? Object.values(rewards)[0];
  return typeof reward === "number" && Number.isFinite(reward) ? reward : null;
}

/** Milliseconds between two ISO timestamps, or null if either is missing or
 *  unparseable, or the span is negative. */
function spanMs(from?: string | null, to?: string | null): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Longest error kept: room for a failing command plus the stderr that
 *  explains it. */
const MAX_ERROR_LEN = 2000;

/** Share of an over-long error kept from its start; the rest comes from its
 *  end. Harbor's "Command failed … stderr: …" messages close with the reason,
 *  so keeping only the head would drop it. */
const ERROR_HEAD_FRACTION = 0.4;

/** Both ends of an over-long error, without the middle. */
export function clipError(full: string): string {
  if (full.length <= MAX_ERROR_LEN) return full;
  const head = Math.floor(MAX_ERROR_LEN * ERROR_HEAD_FRACTION);
  return `${full.slice(0, head)}…${full.slice(head - MAX_ERROR_LEN)}`;
}

function readScoreReason(trial_dir: string): string | null {
  const file = path.join(trial_dir, "verifier", "eval-output.txt");
  if (!existsSync(file)) return null;
  const details = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("DETAILS:"));
  return details.at(-1)?.slice("DETAILS:".length).trim() ?? null;
}

const zAtif = z.object({
  steps: z
    .array(
      z.object({
        source: z.string().optional(),
        tool_calls: z.array(z.unknown()).optional(),
      })
    )
    .default([]),
});

/** Turn and tool-call counts from an ATIF trajectory: one turn per agent
 *  step, tool calls summed over them. Empty when the file is absent. */
export function trajectoryCounts(file: string): {
  stop_reason?: string;
  turns?: number;
  env_tool_calls?: number;
} {
  if (!existsSync(file)) return {};
  const parsed = zAtif.safeParse(readJson(file));
  if (!parsed.success) return {};
  const agentSteps = parsed.data.steps.filter((s) => s.source === "agent");
  return {
    turns: agentSteps.length,
    env_tool_calls: agentSteps.reduce(
      (n, s) => n + (s.tool_calls?.length ?? 0),
      0
    ),
  };
}

/** Everything the suite records about one trial directory, with the calls
 *  its proxy recorded in `agent/calls.jsonl`. */
export function parseTrial(
  trial_dir: string,
  recorded: readonly CallRecord[] = readCallLog(trialCallLog(trial_dir))
): ParsedTrial {
  const result = zTrialResult.parse(
    readJson(path.join(trial_dir, "result.json"))
  );
  const agentDir = path.join(trial_dir, "agent");
  const summaryFile = path.join(agentDir, "summary.json");
  // Our loop writes summary.json. A whole agent (kind: agent) does not; then
  // harbor's ATIF trajectory of its session is the best source for turns.
  const summary = existsSync(summaryFile)
    ? zSummary.parse(readJson(summaryFile))
    : trajectoryCounts(path.join(agentDir, "trajectory.json"));
  const discarded = discardedTurns(
    "errors" in summary ? summary.errors : undefined
  );
  const calls = recorded.map((c) =>
    priceCall(c, c.turn_id !== null && discarded.has(c.turn_id))
  );
  const counted = calls.filter((c) => !c.discarded);
  const totals = {
    input: 0,
    cached_input: 0,
    cache_write_input: 0,
    output: 0,
    reasoning_output: 0,
  };
  for (const call of counted) {
    totals.input += call.usage.input;
    totals.cached_input += call.usage.cached_input;
    totals.cache_write_input += call.usage.cache_write_input;
    totals.output += call.usage.output;
    totals.reasoning_output += call.usage.reasoning_output;
  }
  const unpriced = counted.some((c) => c.cost_cents === null);
  const cost_cents =
    unpriced || counted.length === 0
      ? null
      : counted.reduce((sum, c) => sum + (c.cost_cents ?? 0), 0);
  const exception = result.exception_info;
  const error = exception
    ? clipError(`${exception.exception_type}: ${exception.exception_message}`)
    : null;
  // The agent's own span, else the whole trial's.
  const duration_ms =
    spanMs(
      result.agent_execution?.started_at,
      result.agent_execution?.finished_at
    ) ?? spanMs(result.started_at, result.finished_at);
  return {
    trial_name: result.trial_name,
    trial_dir: trial_dir,
    reward: readReward(trial_dir, result),
    score_reason: readScoreReason(trial_dir),
    error,
    stop_reason: summary.stop_reason ?? null,
    turns: summary.turns ?? null,
    env_tool_calls: summary.env_tool_calls ?? null,
    duration_ms,
    totals,
    calls,
    cost_cents,
  };
}

/** A trial that has an error and nothing else to record. */
export function erroredTrial(
  trial_name: string,
  trial_dir: string,
  error: string
): ParsedTrial {
  return {
    trial_name,
    trial_dir,
    reward: null,
    score_reason: null,
    error,
    stop_reason: null,
    turns: null,
    env_tool_calls: null,
    duration_ms: null,
    totals: {
      input: 0,
      cached_input: 0,
      cache_write_input: 0,
      output: 0,
      reasoning_output: 0,
    },
    calls: [],
    cost_cents: null,
  };
}

/** `trials` padded to `count` with errored placeholders, so a job whose
 *  harbor left trials unrecorded shows every attempt it owed. */
export function withMissingTrials(
  trials: readonly ParsedTrial[],
  count: number,
  jobDir: string
): ParsedTrial[] {
  const missing = Math.max(0, count - trials.length);
  return [
    ...trials,
    ...Array.from({ length: missing }, (_, i) =>
      erroredTrial(
        `missing_${i + 1}`,
        jobDir,
        `harbor recorded ${trials.length} of ${count} trial(s); this one left nothing`
      )
    ),
  ];
}

/** Every trial of a harbor job, discovered from each trial's result.json.
 *  Trials that harbor listed in the job's exception stats but never wrote a
 *  result for come back as errored placeholders. */
export function parseJob(jobs_dir: string, jobName: string): ParsedTrial[] {
  const jobDir = path.join(jobs_dir, jobName);
  if (!existsSync(jobDir)) return [];
  const trials: ParsedTrial[] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(jobDir).sort()) {
    const dir = path.join(jobDir, name);
    if (
      !statSync(dir).isDirectory() ||
      !existsSync(path.join(dir, "result.json"))
    )
      continue;
    // One unreadable trial is that trial's error, not the job's: the rest
    // still count.
    let parsed: ParsedTrial;
    try {
      parsed = parseTrial(dir);
    } catch (err) {
      parsed = erroredTrial(
        name,
        dir,
        clipError(`ingest: ${err instanceof Error ? err.message : String(err)}`)
      );
    }
    seen.add(parsed.trial_name);
    trials.push(parsed);
  }
  const jobResult = path.join(jobDir, "result.json");
  if (existsSync(jobResult)) {
    const parsed = zJobResult.safeParse(readJson(jobResult));
    if (parsed.success) {
      for (const evalStats of Object.values(parsed.data.stats?.evals ?? {})) {
        for (const [type, names] of Object.entries(evalStats.exception_stats)) {
          for (const trial_name of names) {
            if (seen.has(trial_name)) continue;
            seen.add(trial_name);
            trials.push(
              erroredTrial(
                trial_name,
                path.join(jobDir, trial_name),
                `${type}: no trial result written`
              )
            );
          }
        }
      }
    }
  }
  return trials;
}

// ---------------------------------------------------------------------------
// Database rows
// ---------------------------------------------------------------------------

export type JobRow = {
  job_id: string;
  suite_id: string;
  run: SuiteRun;
  target: {
    provider: Provider;
    model: string;
    reasoning_effort?: string;
  };
  concurrency: number;
  command: string;
  jobs_dir: string;
  /** See the job table's `pass`. */
  pass?: number;
};

export async function insertJob(row: JobRow): Promise<void> {
  await getCurrentTransaction()
    .insert(job)
    .values({
      id: row.job_id,
      suite_id: row.suite_id,
      task_name: row.run.task_name,
      runner: row.run.runner,
      driver_name: row.run.driver_name,
      target_name: row.run.target_name,
      provider: row.target.provider,
      model: row.target.model,
      reasoning_effort: row.target.reasoning_effort ?? null,
      count: row.run.count,
      pass: row.pass ?? 0,
      concurrency: row.concurrency,
      command: row.command,
      status: "pending",
      jobs_dir: row.jobs_dir,
    });
}

export async function markJobStarted(
  job_id: string,
  started_at: Date
): Promise<void> {
  await getCurrentTransaction()
    .update(job)
    .set({ status: "running", started_at: started_at })
    .where(eq(job.id, job_id));
}

export function jobStatus(result: JobResult): JobStatus {
  if (result.error?.startsWith("timed out")) return "timed_out";
  if (result.error === "cancelled") return "cancelled";
  return result.ok ? "done" : "failed";
}

/** Where and at what commits a bin/suite invocation ran its trials. */
export type InvocationFacts = {
  harbor_env: string;
  git_sha: string | null;
  harbor_sha: string | null;
  github_run_id: string | null;
  github_run_attempt: number | null;
  github_repository: string | null;
};

/** Record a finished job and every trial and model call it produced. A
 *  trial's invocation facts are its suite's, unless `invocation` says
 *  otherwise: an --append runs its trials later, from another invocation. */
export async function ingestJob(
  suite_id: string,
  job_id: string,
  result: JobResult,
  trials: ParsedTrial[],
  invocation?: InvocationFacts
): Promise<void> {
  await withTransaction(async () => {
    const tx = getCurrentTransaction();
    await tx
      .update(job)
      .set({
        status: jobStatus(result),
        error: result.error,
        exit_code: result.exit_code,
        started_at: result.started_at,
        finished_at: result.finished_at,
      })
      .where(eq(job.id, job_id));
    // Every trial carries its job's and suite's facts (schema.ts: the trial
    // table is fully denormalized).
    const [facts] = await tx
      .select({
        suite_name: suite.name,
        task_name: job.task_name,
        runner: job.runner,
        driver_name: job.driver_name,
        target_name: job.target_name,
        provider: job.provider,
        model: job.model,
        reasoning_effort: job.reasoning_effort,
        pass: job.pass,
        harbor_env: suite.harbor_env,
        git_sha: suite.git_sha,
        harbor_sha: suite.harbor_sha,
        github_run_id: suite.github_run_id,
        github_run_attempt: suite.github_run_attempt,
        github_repository: suite.github_repository,
      })
      .from(job)
      .innerJoin(suite, eq(suite.id, job.suite_id))
      .where(eq(job.id, job_id));
    if (!facts) throw new Error(`no job ${job_id} to store trials under`);
    for (const t of trials) {
      const trial_id = newId("t");
      await tx.insert(trial).values({
        id: trial_id,
        suite_id: suite_id,
        job_id: job_id,
        ...facts,
        ...invocation,
        trial_name: t.trial_name,
        reward: t.reward,
        score_reason: t.score_reason,
        error: t.error,
        stop_reason: t.stop_reason,
        turns: t.turns,
        env_tool_calls: t.env_tool_calls,
        duration_ms: t.duration_ms,
        input_tokens: t.totals.input,
        cached_input_tokens: t.totals.cached_input,
        cache_write_input_tokens: t.totals.cache_write_input,
        output_tokens: t.totals.output,
        reasoning_output_tokens: t.totals.reasoning_output,
        model_calls: t.calls.filter((c) => !c.discarded).length,
        cost_cents: t.cost_cents,
        trial_dir: t.trial_dir,
      });
      if (t.calls.length > 0) {
        await tx.insert(modelCall).values(
          t.calls.map((c) => ({
            suite_id: suite_id,
            job_id: job_id,
            trial_id: trial_id,
            turn_id: c.turn_id ?? "",
            sequence: c.sequence,
            provider: c.provider,
            model: c.model,
            wire: c.wire,
            host: c.host,
            purpose: c.purpose,
            input_tokens: c.usage.input,
            cached_input_tokens: c.usage.cached_input,
            cache_write_input_tokens: c.usage.cache_write_input,
            output_tokens: c.usage.output,
            reasoning_output_tokens: c.usage.reasoning_output,
            duration_ms: c.duration_ms,
            service_tier: c.service_tier,
            cost_cents: c.cost_cents,
            discarded: c.discarded,
          }))
        );
      }
    }
  });
}
