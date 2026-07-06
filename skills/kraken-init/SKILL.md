---
name: kraken-init
description: Use when the user wants to onboard a repository onto Kraken (set up kraken.toml, gates, fleet config) — inspects the project, proposes merge gates, writes the config, and registers the workflow.
---

# Onboard a repository onto Kraken

Kraken merges fleet work through execution gates. Onboarding = writing an
honest `kraken.toml`. Do not invent gates; derive them from the repo.

## Steps

1. Detect the stack (check, in order): `package.json` (+ lockfile → pnpm/npm/yarn),
   `*.sln`/`*.csproj` (dotnet), `Cargo.toml`, `pyproject.toml`, `go.mod`.
2. Derive gate commands from the project's own scripts (e.g.
   `pnpm install --silent`, `pnpm test`, `pnpm build`; or
   `dotnet build <sln> --nologo -v q`). SMOKE-TEST each command once —
   one representative invocation (one package, one stack, one target),
   budget ~2 minutes total — to prove the command is well-formed and the
   tooling exists. Do NOT exhaustively validate the whole repo: Kraken's
   reconcile loop probes trunk against the gates before every execution
   and holds fleet work automatically if trunk is red, so init is a
   smoke test, not an audit. If the smoke test fails, fix the command or
   flag it — a wrong gate poisons every run.
3. Write `kraken.toml` in the repo root:
   - `trunk = "kraken-trunk"` (the integration branch the merge train advances;
     create it from the default branch if missing: `git branch kraken-trunk`)
   - `gates = [...]` from step 2
   - `max_parallel = 3`
   - `allowed_tools = [...]` when tasks in this repo plausibly need commands
     beyond file edits (gh for PR feedback, terraform fmt, package managers).
     Grant NARROWLY (specific subcommands, prefer read-only); arms run
     non-interactive, so anything not granted is silently denied — workers
     will report it as a blocker rather than fail loudly.
   - Optional: `skill_roots` pointing at skill directories, `[[rules]]` blocks
     routing skills by pathPatterns/objectiveTerms, `notify_url` for ntfy push.
4. Register the project on the bridge: call the `register_project` MCP tool
   (or run `kraken onboard` in the repo). Without this the project only
   appears on the bridge after its first run.
5. Confirm to the user: gates chosen and why, trunk branch state, and that
   runs are started with the `start_run` MCP tool or `kraken run "<goal>"`.

## Rules

- kraken.toml is your ONLY deliverable. Never author helper scripts,
  wrappers, or CI files — if no single existing command covers the repo,
  pick the cheapest existing repo-wide checks (fmt/lint/typecheck) and note
  the coverage gap in a toml comment. The judge and exec-time trunk probe
  carry correctness; gates only need to be fast, honest tripwires.
- Gates run on EVERY merge-train car, retry, and trunk probe — budget the
  full gate list at ~2-3 minutes. In monorepos prefer fast static checks
  over exhaustive builds/sweeps; an 11-target validation loop is a CI job,
  not a merge gate.
- Never overwrite an existing kraken.toml without showing a diff first.
- Gates must be non-interactive and deterministic.
- If no build/test system is detectable, say so and write gates = [] with a
  warning comment rather than guessing.
