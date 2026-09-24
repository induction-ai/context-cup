import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  getCurrentTransaction,
  withTransaction,
} from "@context-cup/db/connection.js";
import {
  job,
  modelCall,
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
export function trialCallLog(trialDir: string): string {
  return path.join(trialDir, "agent", "calls.jsonl");
}

/** Every call a proxy log recorded, in order. Each trial has its own proxy,
 *  so every call in the file is that trial's to pay for, whatever trial id
 *  its URL carried. A missing file means no calls were made. */
export function readCallLog(file: string): CallRecord[] {
  if (!existsSync(file)) return [];
  const calls: CallRecord[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const parsed = zCall.safeParse(JSON.parse(line));
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
  trialDir: string,
  result: z.infer<typeof zTrialResult>
): number | null {
  const rewardFile = path.join(trialDir, "verifier", "reward.txt");
  if (existsSync(rewardFile)) {
    const value = Number(readFileSync(rewardFile, "utf8").trim());
    if (Number.isFinite(value)) return value;
  }
  const reward = result.verifier_result?.rewards?.reward;
  return typeof reward === "number" ? reward : null;
}

function readScoreReason(trialDir: string): string | null {
  const file = path.join(trialDir, "verifier", "eval-output.txt");
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
  trialDir: string,
  recorded: readonly CallRecord[] = readCallLog(trialCallLog(trialDir))
): ParsedTrial {
  const result = zTrialResult.parse(
    readJson(path.join(trialDir, "result.json"))
  );
  const agentDir = path.join(trialDir, "agent");
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
    ? `${exception.exception_type}: ${exception.exception_message}`.slice(
        0,
        2000
      )
    : null;
  const started = result.agent_execution?.started_at;
  const finished = result.agent_execution?.finished_at;
  const duration_ms =
    started && finished
      ? new Date(finished).getTime() - new Date(started).getTime()
      : null;
  return {
    trial_name: result.trial_name,
    trial_dir: trialDir,
    reward: readReward(trialDir, result),
    score_reason: readScoreReason(trialDir),
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

/** Every trial of a harbor job, discovered from each trial's result.json.
 *  Trials that harbor listed in the job's exception stats but never wrote a
 *  result for come back as errored placeholders. */
export function parseJob(jobsDir: string, jobName: string): ParsedTrial[] {
  const jobDir = path.join(jobsDir, jobName);
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
    const parsed = parseTrial(dir);
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
            trials.push({
              trial_name,
              trial_dir: path.join(jobDir, trial_name),
              reward: null,
              score_reason: null,
              error: `${type}: no trial result written`,
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
            });
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
      suiteId: row.suite_id,
      taskName: row.run.task_name,
      runner: row.run.runner,
      driverName: row.run.driver_name,
      targetName: row.run.target_name,
      provider: row.target.provider,
      model: row.target.model,
      reasoningEffort: row.target.reasoning_effort ?? null,
      count: row.run.count,
      pass: row.pass ?? 0,
      concurrency: row.concurrency,
      command: row.command,
      status: "pending",
      jobsDir: row.jobs_dir,
    });
}

export async function markJobStarted(
  job_id: string,
  started_at: Date
): Promise<void> {
  await getCurrentTransaction()
    .update(job)
    .set({ status: "running", startedAt: started_at })
    .where(eq(job.id, job_id));
}

export function jobStatus(result: JobResult): JobStatus {
  if (result.error?.startsWith("timed out")) return "timed_out";
  if (result.error === "cancelled") return "cancelled";
  return result.ok ? "done" : "failed";
}

/** Record a finished job and every trial and model call it produced. */
export async function ingestJob(
  suite_id: string,
  job_id: string,
  result: JobResult,
  trials: ParsedTrial[]
): Promise<void> {
  await withTransaction(async () => {
    const tx = getCurrentTransaction();
    await tx
      .update(job)
      .set({
        status: jobStatus(result),
        error: result.error,
        exitCode: result.exit_code,
        startedAt: result.started_at,
        finishedAt: result.finished_at,
      })
      .where(eq(job.id, job_id));
    for (const t of trials) {
      const trial_id = newId("t");
      await tx.insert(trial).values({
        id: trial_id,
        suiteId: suite_id,
        jobId: job_id,
        trialName: t.trial_name,
        reward: t.reward,
        scoreReason: t.score_reason,
        error: t.error,
        stopReason: t.stop_reason,
        turns: t.turns,
        envToolCalls: t.env_tool_calls,
        durationMs: t.duration_ms,
        inputTokens: t.totals.input,
        cachedInputTokens: t.totals.cached_input,
        cacheWriteInputTokens: t.totals.cache_write_input,
        outputTokens: t.totals.output,
        reasoningOutputTokens: t.totals.reasoning_output,
        modelCalls: t.calls.filter((c) => !c.discarded).length,
        costCents: t.cost_cents,
        trialDir: t.trial_dir,
      });
      if (t.calls.length > 0) {
        await tx.insert(modelCall).values(
          t.calls.map((c) => ({
            suiteId: suite_id,
            jobId: job_id,
            trialId: trial_id,
            turnId: c.turn_id ?? "",
            sequence: c.sequence,
            provider: c.provider,
            model: c.model,
            wire: c.wire,
            host: c.host,
            purpose: c.purpose,
            inputTokens: c.usage.input,
            cachedInputTokens: c.usage.cached_input,
            cacheWriteInputTokens: c.usage.cache_write_input,
            outputTokens: c.usage.output,
            reasoningOutputTokens: c.usage.reasoning_output,
            durationMs: c.duration_ms,
            serviceTier: c.service_tier,
            costCents: c.cost_cents,
            discarded: c.discarded,
          }))
        );
      }
    }
  });
}
