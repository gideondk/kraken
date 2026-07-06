# Roadmap — verified-integration layer, next moves

From the 2026-07-06 market check + additive research. Positioning:
"Every agent tool ships code faster; Kraken is the merge authority that
decides — with real gates, a judge that can use tools, and a replayable
journal — whether it lands."

## Now (charter for next sessions)
1. git push + journal unification (bridge/MCP/CLI on one KRAKEN_HOME)
2. Public benchmark: train vs naive parallel PRs (AgenticFlict-style
   workloads; red-trunk minutes, throughput, human interventions)
3. Adversarial-review gate on the train (findings become the eject
   reason and feed fix-forward repair contracts)
4. Walkthrough punch list: campaign-scoped composer, decision triage
   inbox, intent clipping, named wave labels, live activity on slices

## Train (categorically deeper)
- Optimistic parallel batches + auto-bisection; batch size from each
  arm's historical pass rate (Mergify: 50-75% CI cost cut)
- Predictive test selection per car; full suite post-merge (journal is
  the per-fleet training corpus) [arXiv:1810.05286]
- Flaky quarantine as auto-invalidating journal decisions
- Impacted-target parallel lanes (Bazel/Nx-style affected graph)

## Judge (falsifiable, ungameable)
- Diff-scoped mutation gate (5-8 mutants/function): tests that kill no
  mutants don't count as tests [AdverTest arXiv:2602.08146]
- Diff-scoped semantic verification: behavioral-vs-cosmetic classify,
  equivalence-check "refactor" claims
- Judge cascades + difficulty-aware model routing (xRouter-style)

## Autonomy (earned, policied)
- Policy-as-code per tool call (allow/deny/require-approval by risk
  class); per-arm trust score raising auto-approve thresholds with
  merged-and-survived changes [anthropic.com/research/measuring-agent-autonomy]
- Post-merge canary watch: rollback signals invalidate the merge
  decision in the journal and debit the arm's trust score

## Campaigns (the uncopyable composition)
- Speculative downstream execution: start downstream slices against the
  speculative merged state of upstream cars; discard on eject
  [arXiv:2510.04371] — requires train + directed acyclic graph (DAG), which nobody else has
- Steal from Sourcegraph batch changes / Nx affected-graph for
  interface propagation

## Explicitly skipped (market says commodity)
Mobile polish beyond the decision queue; chat beyond the channel; >2
harness adapters; plan-annotation polish.
