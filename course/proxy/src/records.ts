import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Provider } from "@context-cup/shared/provider.js";
import type { Usage, Wire } from "./parsers.ts";

/** One line of calls.jsonl: what one model request cost, and whose it was. */
export type CallRecord = {
  trial_id: string;
  turn_id: string | null;
  sequence: number;
  purpose: string;
  provider: Provider;
  host: string;
  model: string | null;
  wire: Wire;
  usage: Usage | null;
  duration_ms: number;
  status: number;
  service_tier: string | null;
  request_bytes: number;
  response_bytes: number;
  streamed: boolean;
  started_at: string;
  error?: string;
};

/** Per-trial attribution state: the current turn and the call counter. */
export class TrialState {
  private turns = new Map<string, string>();
  private sequences = new Map<string, number>();

  setTurn(trial_id: string, turn_id: string): void {
    this.turns.set(trial_id, turn_id);
  }

  turn(trial_id: string): string | null {
    return this.turns.get(trial_id) ?? null;
  }

  nextSequence(trial_id: string): number {
    const n = (this.sequences.get(trial_id) ?? 0) + 1;
    this.sequences.set(trial_id, n);
    return n;
  }
}

/** Appends records as JSON lines, one write per record so a crash loses at
 *  most the call in flight. */
export class CallLog {
  readonly file: string;
  readonly bodiesDir: string | undefined;

  constructor(file: string, bodiesDir?: string) {
    this.file = file;
    this.bodiesDir = bodiesDir;
    mkdirSync(path.dirname(file), { recursive: true });
  }

  write(record: CallRecord): void {
    appendFileSync(this.file, JSON.stringify(record) + "\n");
  }

  saveBodies(
    record: CallRecord,
    url: string,
    request: Buffer,
    response: Buffer
  ): void {
    if (!this.bodiesDir) return;
    const dir = path.join(this.bodiesDir, record.trial_id);
    mkdirSync(dir, { recursive: true });
    const stem = String(record.sequence).padStart(3, "0");
    writeFileSync(path.join(dir, `${stem}_request.json`), request);
    writeFileSync(
      path.join(dir, `${stem}_response.txt`),
      Buffer.concat([Buffer.from(`${url}\n\n`), response])
    );
  }
}
