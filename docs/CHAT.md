# Project chat — the channel where intent forms

Status: design agreed 2026-07-06, not yet built. Build after the cost ledger.

## Thesis

Runs are verbs; the chat is where intent forms before it becomes a run. It is a
**read-and-plan** agent, not an inline Claude Code: it inspects the repo
(plan-mode arm, same mechanism as ask-the-run), reads the whole project journal
(runs, reports, verdicts, decisions), and holds conversation. Its only outputs
are **answers** and **proposals**. It never edits code — when work is needed it
drafts a plan.

## Mechanics

- `ChatMessage` events in the journal, keyed by repo (the channel outlives runs).
- `/api/chat` streams a plan-mode arm: journal context + conversation tail + question.
- Replies are schema'd with an optional `proposal: { title, goal, why }`. The
  model emits one when the conversation converges on actionable work; the bridge
  renders an inline card with a **plan it** button → existing `startRun` →
  plan review. Chat is follow-up composition with memory.
- Compaction: `distill()` over conversation history when the tail grows.
- Meta-panel (model, tier, cumulative cost, context %) renders from the same
  journaled telemetry as any arm once the cost ledger exists.
- Sidebar: the channel is the top entry of each project group; `+ new session`
  becomes "open the channel", with direct-to-composer as the shortcut.

## Discipline

Chat proposes; the fleet executes. The moment the chat can edit files it is a
slower Claude Code and Kraken loses its reason to exist.

## Prerequisites

1. Cost ledger (`CostIncurred` per dispatch: source, tokens, API-equiv USD,
   billing mode) — feeds the meta-panel.
2. Limit-aware dispatch (`LimitHit {resetsAt}` → pause queue → ntfy → resume)
   if running under a subscription.
