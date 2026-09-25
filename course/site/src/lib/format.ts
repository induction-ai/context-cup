/** Display helpers. Everything the pages print goes through here so numbers
 *  and dates look the same on every table. */

export function cents(value: number | null | undefined): string {
  if (value == null) return "–";
  return `${value.toFixed(value >= 100 ? 0 : 1)}¢`;
}

/** Cents as dollars: `$0.42`, `$4.20`, `$42.0`, `$420`. */
export function dollars(value: number | null | undefined): string {
  if (value == null) return "–";
  const d = value / 100;
  return `$${d.toFixed(d >= 100 ? 0 : d >= 10 ? 1 : 2)}`;
}

/** A ratio as a signed percentage change to a tenth, since the score bar
 *  sits at −1.0%: `+4.2%`, `−0.8%`, `±0.0%`. */
export function change(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return "–";
  const pct = ((ratio - 1) * 100).toFixed(1);
  if (pct === "0.0" || pct === "-0.0") return "±0.0%";
  return pct.startsWith("-") ? `−${pct.slice(1)}%` : `+${pct}%`;
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
  reasoning_effort: string | null;
}): string {
  return `${t.provider}/${t.model}${t.reasoning_effort ? `@${t.reasoning_effort}` : ""}`;
}

/** The GitHub Actions run page for a suite started there, else null. */
export function githubRunUrl(s: {
  github_repository: string | null;
  github_run_id: string | null;
  github_run_attempt: number | null;
}): string | null {
  if (!s.github_repository || !s.github_run_id) return null;
  const base = `https://github.com/${s.github_repository}/actions/runs/${s.github_run_id}`;
  return s.github_run_attempt && s.github_run_attempt > 1
    ? `${base}/attempts/${s.github_run_attempt}`
    : base;
}

export function truncate(text: string | null | undefined, max = 160): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
