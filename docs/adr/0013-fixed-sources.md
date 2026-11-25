# Fixed sources: the owner's own rules, read by file for every attempt

Gives the worker the rules its owner keeps about themselves — how text is to
be written, what must never happen — read from files the configuration names,
on every attempt, ahead of the board's own preferences. Grown from the
hand-off of the other harness on this machine (2026-11-25), after the first
phase of the learning loop was built.

## Context

- The owner's rules lived outside the orchestrator. A harness can be
  configured to load a few profile files into every session it starts; the
  orchestrator knew nothing of them, and its worker got whatever the harness
  happened to load — a different answer on another harness, or after a
  configuration change.
- ADR-0011 gave the worker a preference profile, but that one is the board's:
  `.taskctl/profile.md`, appended per project. The owner's own rules are not
  per project, and nothing in the prompt said which of the two wins where they
  disagree. Two sources for one kind of thing drift, which is how a preference
  is taught and then forgotten again.
- Recall (ADR-0011) is a search: what reaches the worker is what is similar
  enough to the task. A rule that belongs in every prompt cannot depend on a
  similarity score. Reading a file by name is the one memory channel that
  cannot miss.
- The worker prompt is spec-fixed (ADR-0011): every worker shares one
  protocol, and a prompt without a new input has to stay byte-identical.

## Decision

- A new optional key, `fixedSources`: a list of files. Absent or empty,
  nothing is read and the prompt is what it was. Each path is made absolute
  the way `tasksDir` is; nothing else is expanded, and a file need not exist
  for the configuration to be accepted.
- Every attempt reads the files once, as it starts, in the order configured,
  whatever the `workerContext` switches say: these are the owner's rules, not
  this task's context. A file is given whole up to 8,000 characters; past
  that its head and tail are kept (70% and 30%) behind a visible marker, under
  a line that says how long the whole file is, so an excerpt is never taken
  for the file.
- The section is `## 用户本人的规范（跨项目有效，不是检索来的）`, between the work
  rules and the board's preferences. One fixed sentence opens it: these are
  the owner's own rules, read by file and not recalled; the preferences that
  follow are this project's additions, and where the two disagree, these win.
- **The owner's own files are the one source for how text is written and for
  what must never happen.** The board's profile and the corrections add to
  them for one project; neither restates them.
- A source is named by its file name, never by its path — not in the prompt,
  not in the journal, not in the output. A prompt is text a worker may quote
  into what it writes, and a path in it would reach a repository sooner or
  later.
- A file that is missing or cannot be read is a state, not an error: the
  attempt goes on without it, and the journal says so. One `sources` line per
  attempt that reaches the read names every configured file and what came of
  it — read, clipped, empty, missing, or unreadable with the error's code —
  every file missing included. It is skipped only when the attempt never gets
  there: the board's own context files throwing takes the whole read down
  with one `context-unavailable` (ADR-0011's rule).
- `taskctl recall` shows the fixed sources first, as the prompt carries them,
  whether memory is on or not, and exits 1 when one could not be read.
- **The reviewer's input does not change.**

## Consequences

- The owner's rules reach the worker by a path the orchestrator controls: not
  through the harness's configuration, not through a search. The same
  configuration gives the same section on any harness the adapter can start.
- In a session whose harness already loads these files, the worker now holds
  them twice, once from each side: about 3,500 characters for the three files
  the owner keeps today. That is the price of not depending on the harness,
  and the owner chooses it per board by naming the files.
- Where the owner's rules and a board's preference disagree, the prompt says
  the owner's rules win. That is a choice, made because a preference is
  taught and then forgotten exactly when memory is allowed to outrank it. A
  project that needs an exception gets it in the owner's own files, where the
  owner signs it.
- A worker that runs without its rules, because a file was moved, is visible
  after the fact and not before: one journal line, and `taskctl recall` exits
  1. The task is not `blocked` over a file that is only context, as with the
  other context files (ADR-0011).
- The rule about paths is about what taskctl adds, not about what the owner
  writes: a file that holds a path hands that path to the worker verbatim.
- Changing the prompt is a spec change and is handled as `risk: high`, as
  ADR-0011's is: it needs the owner's signature before it is merged.
- Not superseded: ADR-0011 stands for the spec, the board's preferences, the
  corrections and recall. This adds one section to the four it names.
