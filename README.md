# Context Cup

A benchmark harness for context-management strategies, in the spirit of a kart
race. Each **driver** implements a context manager (what to keep, compress,
drop, or retrieve as an agent's context grows). The **course** runs every
driver through the same AI benchmarks and scores them on two axes:

- **Accuracy**: how well the model performs on the benchmark tasks with the
  driver managing its context.
- **Cost**: tokens and dollars spent to get there.

The goal is to match a fixed baseline's accuracy for less money.

## The benchmarks

| benchmark  | suite         | tasks |
| ---------- | ------------- | ----- |
| tau3       | `tau_banking` | 97    |
| Toolathlon | `toolathlon`  | 108   |

The other suites are there to help you test a driver before a full run, and
never count toward the standings:

- `smoke_tau` and `smoke_toolathlon`: one task each, for checking that a
  driver runs end to end.
- `toolathlon_local`: the 35 Toolathlon tasks that need no credentials, for
  a quick read on a driver's score and cost.

## Scoring

A trial is one attempt at one task. It is **done** when it reaches a verdict
without an error; errored or unfinished trials are left out, not counted as
zero.

- A task's score is the mean reward over its done trials, and its cost the
  mean price of those trials.
- A suite's score and cost are the means of its tasks' values.

Every model call a driver makes is in its cost: the main turn, summaries,
reranking, subagents. Each call is priced under the model it named.

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

## Winning

Each benchmark has its own leader, judged on one suite at the reference
target (`gpt-6-sol@medium`),
against a fixed baseline:

| benchmark  | suite         | baseline score | baseline $ per run |
| ---------- | ------------- | -------------- | ------------------ |
| tau3       | `tau_banking` | 0.35           | $50                |
| Toolathlon | `toolathlon`  | 0.67           | $65                |

A run's cost here is a full benchmark run, every task once: the mean cost
per task times the suite's task count.

A driver qualifies on a benchmark when both hold:

- **Score**: at least the baseline's.
- **Cost**: a full benchmark run costs less than the baseline's.

The leader is the qualifying driver with the lowest cost. If none qualifies,
the benchmark has no leader: matching the baseline's score without spending
less wins nothing.

Each driver stands on one run: its most recent run of the suite at the
reference target that is finished and has at least 2 done trials in every
task, retry passes included. Earlier runs, and
runs that miss any of these, do not count; a smoke suite or any suite other
than the two never does. Score and cost are that run's suite-level means
described under [Scoring](#scoring).

Everyone else ranks below the qualifiers, in this order:

1. Qualifiers, cheapest first (the first is the leader).
2. Drivers that reach the baseline's score but cost as much or more, cheapest
   first.
3. Drivers under the baseline's score, best score first.
4. Drivers with nothing scored.

## Entering

A driver is a package under `drivers/`: either a context manager the harness
calls on every turn, or a whole agent of your own that works each task end
to end. [docs/drivers.md](docs/drivers.md) is the guide to writing one: pick
a lane, copy its base driver, and edit.

Try it on the smoke suites and `toolathlon_local` first. To enter, run both
benchmark suites with it:

```
bin/suite tau_banking --driver <your_driver>
bin/suite toolathlon --driver <your_driver>
```

These run at the reference target, 3 attempts per task, so that each task
has room for the 2 completed trials the standings need (see
[Winning](#winning)). A task still short of 2 after the run can be topped up
with `--append <suite_id>` rather than run again. [DEVELOPING.md](DEVELOPING.md)
covers setup.

## Leaderboard

Each benchmark's leaderboard ranks the drivers by the rule under
[Winning](#winning), with the baseline as its own row between the
qualifiers and the rest, and plots every driver's score against the cost of
a full benchmark run. The list of runs shows whether each one is on the
board, superseded by a newer run, or doesn't qualify, and why.
