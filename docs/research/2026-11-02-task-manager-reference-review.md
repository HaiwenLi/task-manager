# Task manager reference review and recommendations

Date: 2026-11-02
Purpose: Improve the existing task manager using lessons from three DSH projects, without copying their agents or replacing existing work wholesale.

Implementation follow-up: taskctl findings T1–T4 are addressed by the focused lifecycle changes described in [ADR-0007](../adr/0007-fenced-execution-and-evidence.md). The findings below preserve the original review snapshot. Local regression coverage is in `tests/lifecycle-safety.test.ts`, `tests/claim.test.ts`, `tests/execution.test.ts`, and `tests/workspace.test.ts`; the real-provider pilot remains unrun. Reference-repository findings R1–R6 are not changes to those projects.

## 1. Executive recommendation

Keep `taskctl` as the independent task-management entry point. Reuse selected, validated ideas from existing durable-controller and agent-loop integrations. Treat OpenCode, Kimi, Pi, and DeepSeek Harness as execution backends, not competing task authorities.

The objective is **more correctly accepted work with less human review time**, not more agents or more cards marked Done.

Start with one low-risk software-maintenance task. Establish safe ownership, cancellation, verification, and acceptance before expanding concurrency, adding every backend, or building a dashboard.

## 2. Scope and confidence

| Reference project | Reference folder | Reviewed revision |
| --- | --- | --- |
| [dsh-web](https://github.com/zhu1090093659/dsh-web) | `dsh-web/` | `b66448e`, `dev` |
| [DSH-taskboard](https://github.com/shengsheng90/DSH-taskboard) | `DSH-taskboard/` | `69a3db3`, `main` |
| [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | `dsh-superagent-prototype/` | `6337fc8`, `main` |

This was a targeted static review of source, documentation, and selected tests—not a comprehensive security audit. No dependencies were installed, plugins launched, live agents invoked, or production data modified. Test suites and proposed reproductions were **not run**. Repository test-count claims are not fresh verification.

Finding labels:

- **Source-supported defect:** a concrete problematic path identified in implementation; no runtime reproduction yet.
- **Conditional trust-boundary limitation:** requires stated filesystem/process permissions or deployment conditions.
- **Intentional behavior / fit gap:** documented behavior that does not meet our proposed requirements; not automatically a bug.
- **Recommendation:** a proposed design, not an existing guarantee.

Reference paths below are relative to the named checkout. Line numbers apply to these revisions.

## 3. Comparison of the three projects

| Dimension | dsh-web | DSH-taskboard | Super-agent prototype |
| --- | --- | --- | --- |
| Main purpose | Broad DSH workspace suite with background task automation | Focused project/task management and execution queue | Proactive, event-driven work for one GitHub repository, optionally Feishu |
| Task authority | Host-owned JSON ledger | SQLite tasks and versioned claims | Domain engine with SQLite state and durable effects |
| Execution | Real DSH sessions, cron, parent-card subtask dispatch | Queue coordinator with DSH workers; configurable concurrency | Routing session plus worker assignments and isolated task directories |
| Completion meaning | Done may be a declaration, run verdict, or inherited parent outcome | Agent submits review; a human actor accepts | Ready without a PR can complete work; PR lifecycle drives other endings |
| Most useful lesson | UI-independent execution, scheduling, execution history | CAS/versioned claims and explicit review lifecycle | Authorization, task/assignment separation, durable side effects, attention-focused UI |

### What is actually implemented versus advertised

- **dsh-web:** agent management tools can move cards to Done, and unfinished descendants can inherit the parent's verdict. Goal verification only applies when the run is actually goal-enabled; global goal mode defaults off. Do not interpret all Done cards as independently verified or human-approved.
- **DSH-taskboard:** there is real queue execution, not just a passive board. Its visual workflow nodes are rendered into prompts rather than executed as a host-enforced node graph. Review state does not itself prove that checks ran.
- **Super-agent:** the README explicitly calls it a research prototype, not an official production product, and says some article designs are not implemented. Its deployment is DSH-specific even though the core ports suggest reusable boundaries.

Evidence: dsh-web `packages/dsh-task-board/README.md:38–58`, `src/host-service.ts:815–842`; DSH-taskboard `src/automation/index.ts:175–255`, `src/execution/index.ts:96–107`, `README.md:323`; Super-agent `README.md:3–9`, `src/core/ports.ts:55–69`.

## 4. Findings: bugs and important limitations

### R1. DSH-taskboard can allow two claims on the same worktree

**Classification:** source-supported correctness defect; high priority before parallel use.

The development-context exclusivity query compares complete serialized JSON, not the underlying worktree identity:

- `src/sqlite/provider.ts:1532–1549`: equality against `development_context_json`.
- `src/sqlite/provider.ts:1559–1565`: validation requires branch/path text but does not establish that the branch matches the physical checkout.
- `src/execution/index.ts:231`: worktree path determines the execution directory.

**Scenario:** two otherwise eligible tasks specify the same worktree path but different branch strings. Their JSON differs, so the exclusion query can admit both, while both workers operate in the same directory. Path aliases are another identity concern to test.

**Impact:** agents can overwrite each other's changes and invalidate verification evidence.

**Recommendation:** lock a canonical resource identity separately from descriptive configuration. Normalize/resolve paths, account for Windows case and aliases, and validate the requested branch against the actual checkout. Add a regression test for same path/different branch before parallel execution.

### R2. DSH-taskboard's human acceptance can be bypassed through its CLI

**Classification:** conditional trust-boundary limitation; important for unrestricted local agents.

- `src/sqlite/provider.ts:688–690`: acceptance requires a human actor and review state.
- `src/cli.ts:88–90`: the CLI constructs a human actor from options, defaulting to `human:cli`.
- `src/cli.ts:226–227`: the CLI exposes task acceptance.

**Scenario:** an execution agent has shell access to this CLI and the task database. It can invoke the same acceptance command as the operator; the actor label does not prove human intent.

**Impact:** tool-level separation alone does not establish human-only approval.

**Recommendation:** distinguish cooperative workflow rules from an enforced security boundary. For stronger separation, isolate the approval service/credentials from execution agents and use separate process or OS permissions. A secret stored where the worker can read it is not sufficient. This is not a claim of an unauthenticated remote exploit.

### R3. DSH-taskboard can enter review without substantive check evidence

**Classification:** intentional behavior / evidence-quality gap.

`src/execution/index.ts:291–298` turns Goal completion into `submitReview(..., 'Completed', ...)`. `src/sqlite/provider.ts:643–646` omits that generic verification string from the stored comment.

**Impact:** a task awaiting review proves lifecycle progression, not that tests ran or requirements passed. Human review remains necessary unless another verifier supplies trustworthy evidence.

**Recommendation:** require structured check results, artifact/revision identity, and execution timestamps. Retain a clear distinction between worker claims and independently observed results.

### R4. dsh-web allows self-declared and inherited completion

**Classification:** documented behavior / mismatch with strict acceptance—not an undocumented bug.

- `packages/dsh-task-board/src/host/agent-tools.ts:356–445`: agents can declare `move-done` or record an external success.
- `packages/dsh-task-board/src/host-ledger.ts:995–1033`: unfinished descendants without newer terminal records can inherit the parent's succeeded/failed verdict, with explicit external provenance.

**Scenario:** a parent reports success without individually recording every descendant. Remaining eligible descendants can become Done without their own execution or verification.

**Recommendation:** keep reported completion, inherited outcome, verified result, and accepted result separate. Do not copy this behavior into taskctl's acceptance gate. Parent success must not automatically certify every child artifact.

### R5. dsh-web verification and spend limits have narrower guarantees than their names suggest

**Classification:** configuration/operational limitation, not necessarily a defect.

- `packages/dsh-task-board/src/host-service.ts:815–842`: goal-mode verification depends on both global and card opt-in, and supports a per-card skip.
- `packages/dsh-task-board/README.md:124–129`: global goal mode defaults off; acceptance involves multiple judge calls and has its own time budget.
- `packages/dsh-task-board/src/host-spend.ts:13–18,81–96`: unavailable usage measurement means the spend gate cannot enforce its cap.

**Recommendation:** expose verification applicability explicitly. Treat usage ceilings as best-effort unless enforcement is proven; maintain separate time, concurrency, retry, and provider-budget controls. Do not silently equate unavailable measurement with safe spending.

### R6. Super-agent is not a production security or acceptance template

**Classification:** documented prototype limitations; no newly reproduced implementation defect established in this review.

- `README.md:3–5`: research-code warning and differences from the design article.
- `docs/003-execution.md:25–29,78–90`: workers operate as the OS user; wrappers and directories are not security boundaries; merge requirements are prompt-governed unless enforced externally.
- `docs/003-execution.md:92–106`: Ready without a PR can end a task; Awaiting review has PR-specific semantics.

**Recommendation:** borrow authorization and lifecycle concepts, not unrestricted worker permissions or coding-only completion semantics. Production merge controls belong in branch protection and trusted controller logic, not only prompts.

## 5. Findings in our own taskctl

These were static findings in this repository, not fixed by the original review itself. See the implementation follow-up above.

### T1. Long-running turns can outlive their ownership lease

**Source-supported correctness defect; high priority.**

`src/worker.ts:314–326` refreshes heartbeat immediately before a prompt, with no periodic renewal during the turn. Default turn timeout is 30 minutes (`src/worker.ts:9–10`), while default lock TTL is 10 minutes (`src/claim.ts:8–9`). Stale claims can be taken over (`src/claim.ts:33–59`).

**Scenario:** worker A is healthy but executes for more than the TTL. Worker B sees its stale lock and starts the same task while A is still running.

**Next:** periodic lease renewal, ownership fencing, and a takeover rule that reconciles/stops the previous execution before allowing new side effects. A timer alone does not fix every ownership race.

### T2. Timeout does not stop underlying execution

**Known implementation limitation with correctness consequences; high priority.**

`src/worker.ts:299–305,325–330` explicitly acknowledges that the adapter cannot cancel the timed-out process. `src/adapters/types.ts:6–19` has no cancellation operation.

**Impact:** a failed attempt may keep editing files while a retry or successor runs. Acceptance commands also need process-lifetime control, not merely a timeout on waiting for their result.

**Next:** extend the execution boundary with cancellation and inspection. Confirm shutdown or mark execution uncertain; do not blindly retry uncertain side effects.

### T3. Acceptance completion does not revalidate ownership

**Source-supported race; high priority before multiple workers.**

`src/worker.ts:350–377` checks/refreshes ownership before running acceptance, then writes Done after a passing result without a fresh ownership check or an atomic fenced status update.

**Scenario:** acceptance lasts beyond a short configured TTL, or ownership is replaced while it runs. The old worker can write Done after another worker took over.

**Next:** bind acceptance to task revision and ownership generation, and condition the final state write on those still being current. A separate check-then-write is not enough to close the race.

### T4. Missing acceptance criteria currently pass

**Intentional policy choice; unsuitable as an implicit production guarantee.**

`src/acceptance.ts:23–26` returns passed/skipped when the command is empty; `src/worker.ts:367–377` warns and then marks Done. This follows existing ADR-0006 rather than contradicting it.

**Next:** make completion policy explicit. For automatic acceptance, require actual checks appropriate to the task. Otherwise submit for review rather than silently treating an absent check as evidence.

## 6. Reuse existing assets, not a fourth orchestrator

| Existing project | Candidate contribution | Validation boundary |
| --- | --- | --- |
| `task-manager` | Task entry point, Markdown definitions, session-chain handoffs, adapters | Ownership/cancellation findings above need attention |
| `multi-agent/controller-candidate` | Durable authority, revision-bound review/acceptance, operator decisions, uncertain-intent recovery | Explicitly deterministic-only; not a proven live-agent integration |
| Existing agent-loop integration | OpenCode planning/execution/review loop, isolated worktrees, bounded rework, artifact bus | Capabilities inspected in documentation; not freshly live-tested here |
| `loop-engineering` | Workflow ideas and delivery guardrails | Claude-specific integration; do not install its configuration wholesale |

Evidence: inspected durable-controller and agent-loop documentation; this repository's `docs/adr/0002-independent-orchestrator-with-agent-adapters.md`. Private integration paths are intentionally omitted from this public review.

Preserve the existing Markdown authority decision until requirements justify a change. If a runtime journal/index is added, define which facts it owns; do not create two independently writable versions of task status.

## 7. Recommended task behavior

- Accept natural-language task descriptions; draft outcome and acceptance criteria before dispatch.
- Keep small tasks small: do not run the full planning/persona team for a trivial fix.
- Use the deeper loop for complex implementation or scientific experiments.
- Treat scientific validation separately: source data, assumptions, numerical gates, reproducibility, and comparison against a baseline—not just a green unit-test suite.
- Present one attention inbox: blockers, conflicting reviews, scope changes, high-impact approvals, and concise results. Avoid routine agent chatter.
- Distinguish worker completion, independent verification, and policy-authorized acceptance.

### Risk-based review, not mandatory manual review of everything

| Risk class | Proposed gate |
| --- | --- |
| Low-risk, reversible, objectively checkable | Required checks; eligible for automatic acceptance under an approved policy |
| Moderate-risk implementation | Checks plus independent artifact review; disagreement or missing evidence escalates |
| Deployment, permissions, destructive actions, external communications | Explicit human approval within the authorized scope |

Reviewer agreement is not proof. Reviewers should inspect the actual revision/artifact and independently run relevant checks. Different models can share the same blind spot. Run a deeper reviewer set only when risk or uncertainty justifies its cost.

## 8. Next steps and acceptance criteria

### Step 1 — Focused reuse audit and integration design

Inspect implementation and targeted tests in the existing projects. Identify reusable boundaries and unresolved lifecycle issues; do not merge repositories or rewrite storage. Produce a small design with one owner for each state, execution-attempt identity, evidence format, and acceptance policy. Get the operator's approval before implementation.

### Step 2 — Make one OpenCode execution safe

Address lease renewal/fencing, cancellation, stale acceptance, and isolated workspaces. Persist enough execution identity to reconcile restart and uncertainty. Test with deterministic fixtures before any live provider use.

Required checks: no duplicate active owner after takeover; stale workers cannot finish tasks; timeout cannot cause an overlapping retry; restart does not blindly repeat uncertain external actions; existing task files still load.

### Step 3 — One end-to-end maintenance pilot

Select one explicitly authorized, low-risk task in a disposable/test repository. Run worker → independent verification → concise acceptance result. Bind evidence to the exact revision. Measure completion quality, elapsed time, model usage where available, rework, and human review minutes. Any paid/live run needs its own explicit approval.

### Step 4 — Expand only after the lifecycle works

Add Kimi, Pi, and DSH adapters incrementally. Declare capabilities such as start, inspect, resume, cancel, and collect evidence; unsupported behavior stays visible. Add parallel execution only across non-conflicting resources and dependency-ready tasks. Add proactive triggers in observe-only mode before enabling autonomous intake.

Do not begin with a dashboard, automatic production deployment, all-to-all agent teams, or autonomous acceptance-policy changes.

## 9. Bottom line

Learn **background operations** from dsh-web, **claims and review flow** from DSH-taskboard, and **authorization plus durable dispatch** from Super-agent. Build the product around taskctl, durable authority, and validated execution-loop boundaries.

The first milestone is one safely executed, evidence-backed task that saves review time. This report records findings and a proposed direction; it does not claim the defects are fixed or that any system is production-ready.
