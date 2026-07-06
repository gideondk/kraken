# Helm UX Blueprint — v2 (research-grounded)

Source: adversarially verified research pass (2026-07-06, 104 agents, 25/25 claims
confirmed) over OpenAI Codex app, Claude Code Desktop/Web, and Cursor docs and
announcements. This document is the founding spec for the helm rebuild.

## The verdict on today's helm

The flagship agent apps are **not dashboards**. All of them converge on:
sessions-list sidebar → conversation/timeline spine → anchored review pane.
The helm's card grid must become an application with that IA.

## Target information architecture

```
┌──────────────┬──────────────────────────────┬─────────────────────┐
│ SIDEBAR      │ RUN SPINE (timeline/chat)    │ REVIEW PANE         │
│ runs/sessions│ plan → waves → arm steps →   │ per-arm diffs,      │
│ grouped by   │ judge verdicts → train cars  │ per-file collapse,  │
│ project,     │ → decisions INLINE, in order │ stage/revert-style  │
│ status-      │ tool calls collapsed to      │ actions, line       │
│ filtered,    │ one-line rows, expandable    │ comment-to-steer    │
│ auto-archive │ composer docked at bottom    │                     │
└──────────────┴──────────────────────────────┴─────────────────────┘
```

## Verified patterns to adopt

1. **Sidebar of runs, grouped by project** (Codex threads-by-project; Claude
   sessions sidebar with status/project/environment filters, group-by-project,
   auto-archive when merged). Kraken: runs grouped by repo, filter by
   status/harness, archive on `RunCompleted(success)`.
2. **The run is a conversation, not a card.** Spine = chronological timeline of
   the journal: PlanProposed (expandable contract cards), per-arm step rows,
   CheckpointJudged, MergeCar events, DecisionRequested — all inline, in causal
   order. The composer (steer/new instruction) docks at the bottom like a chat.
3. **Dialable progress granularity** (Claude Ctrl+O view modes): Normal = tool
   calls collapsed to one-line summaries ("→ Edit Program.cs ✓"), Verbose = every
   ArmActivity, Summary = only verdicts/merges. Default Normal; Summary is the
   multi-run scanning mode. Kraken already journals ArmActivity — this is a
   pure presentation dial.
4. **Codex-style step summaries**: "Thought 7s · Explored 2 files · Edited
   hero.tsx ✓" — aggregate consecutive ArmActivity events into grouped rows
   with counts + elapsed, completion ✓/✕ inline.
5. **Review pane = Git semantics, not accept/reject buttons** (Codex: scope
   switch All-branch/Last-turn, per-file collapse, stage/revert at diff, file,
   and hunk level). Kraken v1: per-arm diff scoped to branch-vs-trunk with
   per-file collapse (exists) + actions: `fix-forward with note`, `merge car`,
   `park` — Kraken's analogue of stage/revert is train actions.
6. **Comment-to-steer on diff lines** (universal in Codex + Claude web: click a
   line → inline comment → batch submit → becomes the agent's next-turn
   guidance). Kraken: line comments accumulate into the fix-forward repair
   contract. THIS IS THE FLAGSHIP INTERACTION — it is exactly Kraken's
   steering philosophy.
7. **Decisions inline in the thread, scoped like permissions** ("approve once"
   vs "for this session"; Claude plan-approval sets the follow-on permission
   mode). Kraken: decision rows render inline in the spine where they occurred;
   the global Decisions list becomes a **Triage inbox** (Codex Automations
   pattern) reserved for *finished background runs* and cross-run outcomes —
   not the primary surface. Push stays for gates.
8. **Fight approval fatigue by design** (Anthropic: 93% of prompts are
   approved → prompts train inattention; auto-mode + "recently denied" tab +
   auto-fallback after repeated blocks). Kraken: judge-pass + gates-green waves
   should merge without asking; decisions only for judge-fail/eject/plan.
   Add per-run autonomy dial: manual / cruise (current) / full-auto.
9. **Live diffs during the turn** (Cursor: diff renders while the agent works;
   mid-run stop/redirect). Kraken: review pane streams the arm's worktree diff
   while status=dispatched; add stop-arm action.
10. **Light theme option matters** — Codex/Claude ship light-first surfaces;
    keep abyssal dark as default, add a proper light theme via tokens.

## Ranked build order

1. Sidebar + spine + pane shell (replaces card grid; TanStack Router routes:
   `/` → last run, `/run/$id`, sidebar always visible).
2. Timeline spine renderer over the journal (inline decisions, grouped steps).
3. View-mode dial (Normal/Verbose/Summary).
4. Review pane: per-arm diff + train actions + live diff for running arms.
5. Comment-to-steer → fix-forward contract.
6. Triage inbox for finished runs; inline decisions elsewhere.
7. Autonomy dial per run.
8. Light theme.

## Open questions (unverified — decide by taste or prototype)

- Multi-arm comparison UX has no prior art (no researched app runs N competing
  agents with a judge); nearest patterns are Codex parallel threads.
- Exact visual specs (sidebar px, type scale) unpublished — derive from
  screenshots by eye.
- Whether a triage inbox scales to fleet-volume judge/train events, or needs
  digest/batching.
