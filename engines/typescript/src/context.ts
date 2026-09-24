/** What a TypeScript driver's `run(ctx)` receives. */
import type { EngineContext } from "@context-cup/protocol/engine.js";
import type {
  Dirs,
  Payload,
  ProviderInfo,
  Target,
  TurnInput,
} from "@context-cup/protocol/models.js";
import { view, write, type Conversation } from "@context-cup/protocol/view.js";

/** The turn's input, read only, plus the two things a driver may change:
 *  `contextPayload` (the working copy of the conversation) and `state`.
 *
 *  - `contextPayload`: the provider's native request body. It persists: the
 *    course appends the model's reply and the tool results to what the
 *    driver left and hands it back next turn.
 *  - `state`: any JSON, `{}` on turn one; what it holds when `run` returns
 *    comes back next turn.
 *  - `originalPayload`: the full record, appended each turn, never edited.
 *  - `first`, `provider` (name, placeholder key, proxy base URL), `target`
 *    (model, reasoning effort), `dirs` (`turn`, new each turn; `state`,
 *    kept for the trial; `workspace`), `turnId`, `config` (the manifest's
 *    `contextCup.config`), and `turn`, the whole `input.json`.
 *  - `view()` / `write(conversation)`: read `contextPayload` as a
 *    provider-neutral conversation and put edits back.
 *
 *  `run(ctx)` returns the provider's response as JSON: what an SDK call
 *  resolves to, or the parsed body of a `fetch`. engines/typescript/README.md
 *  has examples of each. */
export class TypeScriptContext implements EngineContext {
  contextPayload: Payload;
  state: any;

  /** The whole `input.json`, as the runner wrote it. */
  readonly turn: TurnInput;
  /** The manifest's `contextCup.config`. */
  readonly config: Record<string, any>;

  constructor(turn: TurnInput, config: Record<string, any> = {}) {
    this.turn = turn;
    this.config = config;
    this.contextPayload = structuredClone(turn.context_payload);
    this.state = structuredClone(turn.state);
  }

  get first(): boolean {
    return this.turn.first;
  }

  get provider(): ProviderInfo {
    return this.turn.provider;
  }

  get target(): Target {
    return this.turn.target;
  }

  get originalPayload(): Payload {
    return this.turn.original_payload;
  }

  get dirs(): Dirs {
    return this.turn.dirs;
  }

  get turnId(): string {
    return this.turn.turn_id;
  }

  /** `contextPayload` as a provider-neutral conversation. */
  view(): Conversation {
    return view(this.provider.name, this.contextPayload);
  }

  /** Apply the conversation's edits to `contextPayload`. */
  write(conversation: Conversation): void {
    this.contextPayload = write(
      this.provider.name,
      this.contextPayload,
      conversation
    );
  }
}
