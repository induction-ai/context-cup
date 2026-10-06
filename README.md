# Context Cup

A benchmark harness for context-management strategies, in the spirit of a kart
race. Each **driver** implements a context manager (what to keep, compress,
drop, or retrieve as an agent's context grows). The **course** runs every
driver through the same AI benchmarks and scores them on two axes:

- **Accuracy**: how well the model performs on the benchmark tasks with the
  driver managing its context.
- **Cost**: tokens and dollars spent to get there.

The goal is to match a fixed baseline's accuracy for less money on both
benchmarks. The driver that does it for the least wins the cup. You develop
a driver on the practice suites and enter it with a pull request; the
competition runs the full benchmarks on every entry (see
[Entering](#entering)).

## The benchmarks

| benchmark  | suite         | tasks |
| ---------- | ------------- | ----- |
| tau3       | `tau_banking` | 97    |
| Toolathlon | `toolathlon`  | 107   |

The competition runs these two suites on every entry. The full `toolathlon`
suite needs credentials for outside services, so for developing a driver
there are practice suites, which never count toward the standings:

- `smoke_tau` and `smoke_toolathlon`: one task each, for checking that a
  driver runs end to end.
- `toolathlon_local`: the 35 Toolathlon tasks that need no credentials, for
  an easier-to-access read on a driver's score and cost.

## Scoring

A trial is one attempt at one task. It is considered valid when it reaches a
verdict without an error; errored or unfinished trials are left out, not
counted as zero. Every task runs several times, and needs at least 2 valid
trials to count, so no score rests on a single attempt.

- A task's score is the mean reward over its valid trials, and its cost the
  mean price of those trials.
- A suite's score and cost are the means of its tasks' values.

Every model call a driver makes is in its cost with the model(s) it used.

## Rules

- **Models**: a driver may call any model from the target's provider, as
  often as it likes. At `gpt-6-sol@medium` that is any OpenAI model. The
  target is the default, not a requirement: a cheaper OpenAI model for
  summaries is fair game, an Anthropic or Gemini model is not.
- **One endpoint**: every model call goes to the base URL the driver is
  given for that provider, and nowhere else.
- **No other external calls**: no web search, no outside APIs or services,
  no downloads while a task runs. Installing the driver's own dependencies
  during setup is fine; after that, the model endpoint and the task's own
  tools are the only ways out.
- **No overfitting**: submissions are reviewed for anything that looks like
  overfitting to these benchmarks. Submit a generic context-management
  solution.

## Winning

The cup goes to one driver: the leader of the combined leaderboard. To lead
it, a driver beats the baseline on both benchmarks, and does it for the
least money.

### Qualifying

Each benchmark is judged on one suite at the reference target
(`gpt-6-sol@medium`), against a fixed baseline:

| benchmark  | suite         | baseline score | baseline $ per run |
| ---------- | ------------- | -------------- | ------------------ |
| tau3       | `tau_banking` | 0.42           | $40                |
| Toolathlon | `toolathlon`  | 0.58           | $25                |

A driver qualifies for the cup when, on every benchmark, both hold:

- **Score**: rounded to two decimals, at least the baseline's.
- **Cost**: a full benchmark run, every task once (the mean cost per task
  times the suite's task count), costs less than the baseline's.

Matching the baseline's score without spending less wins nothing, and
neither does beating one benchmark alone.

Each driver stands on one run per benchmark: the competition's most recent
run of the suite with it, at the reference target, that is finished, covers every task in the
suite file (a run narrowed with `--task` is not a full run), and has at
least 2 valid trials in each, retry passes included. Earlier runs, and runs
that miss any of these, do not count; a smoke suite or any suite other than
the two never does. Score and cost are that run's suite-level means
described under [Scoring](#scoring).

### The winner

Of the qualifiers, the one that spends least against the baselines wins.
That is measured across both benchmarks as the geometric mean of its cost
ratios, each benchmark's run cost over the baseline's:

    √( (tau_banking cost ÷ $40) × (toolathlon cost ÷ $25) )

Lowest wins. A benchmark counts for as much however dear its runs: the
baselines' costs are constants in that product, so they drop out of the
order, and halving a cost counts the same on either benchmark. A big saving
on one can outweigh an even saving on both. At half the baseline's cost on
tau3 and 95% of it on Toolathlon, a driver comes to √(0.5 × 0.95) ≈ 0.69,
and beats one at 70% on both (0.70). With no qualifier, no one leads.

### The standings

The combined leaderboard ranks every driver, in this order:

1. Qualifiers, lowest mean first (the first is the leader).
2. Drivers that reach both baselines' scores but not both costs, lowest
   mean first.
3. Drivers under a baseline's score, by their worse score ratio (score over
   the baseline's), best first.
4. Drivers without a standing run on both benchmarks.

Each benchmark also has its own leaderboard, to see where a driver stands on
one. It applies the same bar to that benchmark alone and ranks qualifiers
cheapest first, then those that reach the score but cost as much or more
(cheapest first), then those under it (best score first), then those with
nothing scored. Leading one wins nothing on its own.

## Entering

A driver is a package under `drivers/`: either a context manager the harness
calls on every turn, or a whole agent of your own that works each task end
to end. [docs/drivers.md](docs/drivers.md) is the guide to writing one: pick
a lane, copy its base driver, and edit.

While developing, run it on the smoke suites, `tau_banking`, and
`toolathlon_local`, which needs no credentials. Run them on
[Daytona](https://www.daytona.io): put a Daytona API key in `.env` as
`DAYTONA_API_KEY` and add `--harbor_env daytona`. You do not need Docker.
Daytona, a sponsor of the cup, gives every competitor $100 in credits on
signing up.

```
bin/suite tau_banking --driver <your_driver> --harbor_env daytona
bin/suite toolathlon_local --driver <your_driver> --harbor_env daytona
```

These run at the reference target, 3 attempts per task. On Daytona every
task gets its own cloud sandbox and up to 64 run at once, so a full
`tau_banking` run takes about 40 minutes. Without `--harbor_env daytona` the
tasks run in local Docker, two or four at a time, and the same run takes
hours. [DEVELOPING.md](DEVELOPING.md) covers setup.

The full `toolathlon` suite needs credentials for outside services, so the
competition runs the benchmarks: to enter, open a pull request adding your
driver under `drivers/`, and we run both full benchmark suites with it for
the standings (see [Winning](#winning)).

The pull request adds `drivers/<your_driver>/` and changes nothing outside
it. Before a full run, an entry is reviewed in three steps: a static check
of its files, a Claude Code review of its code against the [rules](#rules),
and a smoke run of `smoke_tau` and `smoke_toolathlon` at the reference
target. `bin/review_driver --claude --smoke` runs all three on your branch
and says whether it passes; see [Enter it](docs/drivers.md#enter-it).

## Leaderboard

The combined leaderboard and each benchmark's rank the drivers by the rules
under [Winning](#winning), with the baseline as its own row between the
qualifiers and the rest. A benchmark's board plots every driver's score
against the cost of a full benchmark run; the combined board plots each
driver's worse score ratio against its mean cost ratio. The list of runs
shows whether each one is on the board, superseded by a newer run, or
doesn't qualify, and why.
