# Kraken

```
                 █████
                ███████
               █████████
               ██ ███ ██
               █████████
               █████████
                █ █ █ █
                █ █ █ █
               █  █ █  █
```

**One head, many arms — the fleet layer for coding agents.**

**Docs: [gideondk.github.io/kraken](https://gideondk.github.io/kraken/)** · start there — it types out a fleet session for you.

---

Something changed this year. Agents write good code faster than you can read
it. Ask for a feature and four branches appear before your coffee cools —
each one confident, each one plausible, and no honest way to know which of
them deserves your trunk.

The bottleneck moved. It isn't *writing* code anymore. It's **landing** it:
deciding, with evidence, that a change belongs in the codebase — while three
other agents are landing theirs on the same trunk at the same time.

Every agent tool ships code faster. **Kraken is the merge authority that
decides whether it lands.**

## What a fleet session feels like

```
❯ kraken run "add rate limiting to the public API"

  planned 3 contracts · plan awaiting your review

❯ kraken decide a3f8 plan-a3f8 approve "mirror the worker queue's retry semantics"

  ⟶ limiter-core, limiter-headers, limiter-docs — arms dispatched in worktrees
  ⟶ judge limiter-core: PASS 0.92 — atomic refill verified under concurrency
  ⟶ train: 3 cars gated against predicted trunk · 3 merged
  ⟶ trunk green · run complete · $1.91
```

You state the outcome and approve a plan. Arms work in parallel, in isolated
worktrees, under contracts that say what they own and what done means. A judge
scores the end state — with your gates as evidence that outranks anything the
agent claims. A merge train lands the survivors one atomic, fully-gated step
at a time. And everything — every verdict, every decision, every merge, yours
or the machine's — is an append-only event you can replay and audit.

You steer. The machine does everything that didn't need you.

## Why it's different

Three things you won't find elsewhere, each born from watching real fleets
fail:

- **A judge with hands.** Agents are confident; that's the problem. Kraken's
  judge runs your gates first, scores the end state against the contract, and
  — when the worker had tool access — inherits those same tools to verify
  external claims itself. "I posted the review replies" gets checked, not
  believed.
- **A merge train, not a pile of pull requests.** ~28% of agentic changes
  conflict; semantic conflicts break green builds even when the textual merge
  succeeds. Every change is validated against the *predicted* trunk in a
  throwaway worktree, offenders eject alone, entangled work merges atomically
  as a group, and mechanical failures heal themselves before anyone asks you.
- **A journal that never lies.** Every contract, checkpoint, verdict, decision
  and merge is an append-only event (SQLite). Crash and resume for free.
  Decisions auto-invalidate when reality changes. Who decided what — you, the
  judge, or the machine — is a recorded fact, forever.

And when one repository isn't enough: **campaigns** chain single-repo runs
across a dependency graph, carrying each run's interface changes into the
goals of the runs that depend on it.

## Quick start

```sh
# in your repo
cat > kraken.toml <<'EOF'
trunk = "main"
gates = ["pnpm test"]     # fast, honest tripwires — every merge must pass
max_parallel = 4
EOF

kraken run "Implement the delete-awareness spec in docs/specs/..."
kraken decisions                      # the plan pauses for you
kraken decide <run> plan-<run> approve
kraken exec <run>                     # arms fan out, the train lands them
```

Gates are arbitrary commands — a test suite, a typecheck, or any adversarial
reviewer that speaks exit codes. Findings become the eject reason and flow
straight into a repair contract.

## Drive it from Claude Code

Kraken ships as a Model Context Protocol (MCP) server and a Claude Code
plugin, so any session becomes a bridge:

```sh
claude mcp add kraken -- node --experimental-strip-types <kraken>/packages/cli/src/index.ts mcp --repo $(pwd)
```

Then `start_run`, `decide`, `execute_run`, `run_status`, `conflict_radar` —
or install the plugin and let the `kraken-init` skill onboard a repository
for you.

## The bridge, on your phone

`kraken serve` hosts a mobile-first web app over the journal: review plans
(select any text to annotate it), watch arms think in real time, drain the
decision queue, steer campaigns. Put it on your tailnet, pin it to your home
screen, and set `notify_url = "https://ntfy.sh/<topic>"` — every decision
that needs you lands on your lock screen.

**[The visual tour](https://gideondk.github.io/kraken/bridge/tour/)** shows
all of it with real screenshots.

## Honest status

The core loop is real and exercised end-to-end: plan → review → parallel arms
with routed skills → judged checkpoints → speculative train → green trunk,
plus auto-heal, campaigns, scoped permission grants, and both Claude Code and
Codex arms. 45 tests run against real git repositories — nothing mocks git.
What it is not: an agent harness, a CI system, or a code editor. The judge is only
as good as your gates, and the docs say so plainly.

## Development

```sh
pnpm install
pnpm test        # 45 tests, real git repos, no mocks of git
```

Built with an event-sourced core so every claim above is checkable: read the
journal, replay the run, see who decided what. That's the whole philosophy —
**verification over trust**, applied to itself.
