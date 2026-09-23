/** Display helpers. Everything the pages print goes through here so numbers
 *  and dates look the same on every table. */

export function cents(value: number | null | undefined): string {
  if (value == null) return "–";
  return `${value.toFixed(value >= 100 ? 0 : 1)}¢`;
}

export function reward(value: number | null | undefined): string {
  if (value == null) return "–";
  return value.toFixed(2);
}

export function count(value: number | null | undefined): string {
  if (value == null) return "–";
  return value.toLocaleString("en-US");
}

export function tokens(value: number | null | undefined): string {
  if (value == null) return "–";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(0)}k`;
  return value.toLocaleString("en-US");
}

/** `1h 02m`, `4m 31s`, `12s`, or `850ms`. */
export function duration(ms: number | null | undefined): string {
  if (ms == null) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Elapsed between two instants, or from start to now when still running. */
export function elapsed(
  start: Date | null | undefined,
  end: Date | null | undefined,
  now: Date = new Date()
): string {
  if (!start) return "–";
  return duration((end ?? now).getTime() - start.getTime());
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "–";
}

export function when(value: Date | null | undefined): string {
  if (!value) return "–";
  return value.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** `openai/gpt-5.5@medium`. */
export function targetSpec(t: {
  provider: string;
  model: string;
  reasoningEffort: string | null;
}): string {
  return `${t.provider}/${t.model}${t.reasoningEffort ? `@${t.reasoningEffort}` : ""}`;
}

/** The GitHub Actions run page for a suite started there, else null. */
export function githubRunUrl(s: {
  githubRepository: string | null;
  githubRunId: string | null;
  githubRunAttempt: number | null;
}): string | null {
  if (!s.githubRepository || !s.githubRunId) return null;
  const base = `https://github.com/${s.githubRepository}/actions/runs/${s.githubRunId}`;
  return s.githubRunAttempt && s.githubRunAttempt > 1
    ? `${base}/attempts/${s.githubRunAttempt}`
    : base;
}

export function truncate(text: string | null | undefined, max = 160): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
