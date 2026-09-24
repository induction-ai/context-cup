/** An engine's own bookkeeping, kept only for turns the runner accepted. The
 *  twin of `context_cup_protocol/snapshot.py`.
 *
 *  An engine that carries something across turns in `dirs.state` (a working
 *  conversation) must not let an attempt the runner then threw away (an empty
 *  reply, a failed turn) leak into the retry. `state` itself is safe, since
 *  the runner echoes it back only from an accepted output, but a file an
 *  engine writes is not. So each turn's snapshot is saved under its
 *  `turn_index`, which every attempt at a turn shares and which moves on only
 *  when a turn is accepted: a turn reads the snapshot of `turn_index - 1`,
 *  and a retry overwrites its discarded attempt's. */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { TurnInput } from "./models.ts";

/** The snapshot the last accepted turn saved under `name`, or undefined on
 *  the first turn or when there is none. Older snapshots are removed. */
export function loadSnapshot<T>(turn: TurnInput, name: string): T | undefined {
  if (turn.first) return undefined;
  const folder = path.join(turn.dirs.state, name);
  const previous = turn.turn_index - 1;
  for (const file of existsSync(folder) ? readdirSync(folder) : []) {
    const index = /^(\d+)\.json$/.exec(file)?.[1];
    if (index !== undefined && Number(index) < previous) {
      rmSync(path.join(folder, file), { force: true });
    }
  }
  const file = path.join(folder, `${previous}.json`);
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as T)
    : undefined;
}

/** Save this turn's snapshot under `name`; the next turn loads it. */
export function saveSnapshot(
  turn: TurnInput,
  name: string,
  value: unknown
): void {
  const folder = path.join(turn.dirs.state, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, `${turn.turn_index}.json`),
    JSON.stringify(value)
  );
}
