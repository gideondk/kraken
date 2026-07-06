---
name: kraken-fleet
description: Use when work could be delegated to the Kraken fleet (parallelizable, multi-file, well-boundaried tasks) — decide inline-vs-fleet, compose a complete goal, and drive the run via MCP tools.
---

# Delegate to the Kraken fleet

You have MCP tools: start_run, list_decisions, decide, execute_run,
run_status, conflict_radar.

## When to delegate (vs. doing it inline)

Delegate when the work splits into 2+ tasks with DISJOINT file ownership and
a verifiable end state (build/tests). Do it inline when it is a single-file
edit, exploratory, or needs conversation-context the planner can't get.

## Composing the goal (this determines run quality)

start_run's goal must be self-contained: intent, hard constraints, what done
looks like, and sequencing hints if tasks depend on each other. The planner
never sees this conversation — put everything needed in the goal. Vague
delegation is the #1 multi-agent failure mode.

## Driving the run

1. `start_run(goal)` → returns runId; plan waits for approval.
2. Review the plan (run_status). Approve with
   `decide(runId, "plan-<runId>", "approve", annotation?)` — annotations
   travel into contracts. Reject with choice "replan" + notes to revise.
3. `execute_run(runId)` — long-running; arms work in isolated worktrees and
   merge through gates on the train.
4. Drain `list_decisions` when the fleet escalates (ejections, judge
   failures); prefer "fix-forward" with a steering note over park.
5. Report outcomes from run_status honestly: per-task status, judge scores,
   costs, and anything parked.

The human can watch and decide from the web bridge simultaneously — the
journal is shared; decisions made there appear here and vice versa.
