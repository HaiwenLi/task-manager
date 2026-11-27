# The lane is declared by the operator

Restates ADR-0009's "no classifier decides a lane" after the intake
classification of §16.1 of the 2026-11-24 adaptive execution design had
reversed it, and retires the "explicit statement in the user's own words"
path of ADR-0008: nothing in the wording of an intent decides whether a
task runs without a signature. Design: [Model trouble and operator
control](../superpowers/specs/2026-11-25-model-trouble-and-operator-control-design.md),
§12.

## Context

- From 2026-11-24 the clarify session proposed the management lane
  (`quick` / `simple` / `complex`) from the intent. A `simple` verdict opens
  the task at once, without a signature. A wrong downgrade is silent: the
  task runs before anyone reads the spec.
- Separately, `taskctl add` read the intent for "简单任务" and opened the task
  when it found the words. A sentence in the intent — written by the
  operator, or by an agent on his behalf — stood in for his decision.
- Both decided, from words, the one thing ADR-0008 calls expensive to get
  wrong, and neither left a record that could later show how often it was
  right: `classification.json` held a proposal, not a judged example.

## Decision

- `taskctl add` requires the lane: `--quick`, `--simple` or `--complex`.
  With none given it asks once on a terminal, and otherwise exits with a
  usage error that names the three. It never chooses a lane by itself.
- The clarify session no longer classifies. It still returns the
  information-sufficiency verdict and at most three questions; a
  `needs-information` verdict keeps the task in `draft` whatever the lane.
- `classification.json` records the declared lane with
  `source: "operator"`. There is no proposed lane, and nothing to count as
  an escalation.
- Every `taskctl add` that declares a lane and gets a task onto the board
  appends one line to `.taskctl/lanes.jsonl`: id, time,
  lane, task type, title, the intent (bounded) and the number of criteria.
  `taskctl lanes` prints them grouped by lane.
- `detectComplexity` is removed.

## Consequences

- A task cannot run without the owner's signature because of how its
  intent was worded. The lane is the operator's statement — a flag, or a
  typed answer — and nothing else.
- An agent that adds tasks on the owner's behalf has to ask him for the
  lane first. A script that calls `add` without a lane fails loudly instead
  of guessing.
- The `分类升级` row of `taskctl metrics` can only ever count records
  written before this decision. It is kept so that history still reads.
- `.taskctl/lanes.jsonl` is the evidence a classifier needs: declared lanes
  beside the intents they were declared for. Once there are enough of them,
  a cheap model may propose a lane from these examples — as a proposal the
  operator confirms, never as the decision.

## Limits

The operator can still declare the wrong lane; escalation during the run
(ADR-0009) is what catches that, as before. Examples accumulate only where
`add` is used: tasks written by hand or published by `split` record none.
The file is best-effort evidence, not a census: an `add` refused for a
missing lane or by the budget guard records nothing, a crash between the
task write and the append or a failed append loses that one example, and
`criteria: 0` means either the clarify session failed or extraction did.
