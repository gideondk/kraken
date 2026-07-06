import type { Arm, ArmResult, DispatchInput, TierMap } from "./arm.ts";
import { renderPrompt } from "./arm.ts";
import { run } from "./claude.ts";

/**
 * Tier → model mapping for the July 2026 Codex lineup (older Codex-lineage API
 * models — gpt-5.2-codex, gpt-5-codex, codex-mini — sunset on 2026-07-23):
 *   fast     → gpt-5.4-mini  (≈30% of gpt-5.4's usage cost; no xhigh effort)
 *   standard → gpt-5.4       (flagship all-rounder, recommended default 2026-03)
 *   frontier → gpt-5.5       (newest frontier model, recommended default 2026-04)
 * PROVENANCE: https://developers.openai.com/codex/models and
 * https://developers.openai.com/codex/changelog (as of 2026-07).
 */
const DEFAULT_TIERS: TierMap = {
  fast: "gpt-5.4-mini",
  standard: "gpt-5.4",
  frontier: "gpt-5.5",
};

/**
 * OpenAI Codex arm via the documented headless interface: `codex exec --json`
 * with the prompt on stdin ("-" positional). Every tool step the worker takes
 * is surfaced live through onActivity, mirroring ClaudeArm — arms are not
 * black boxes regardless of harness.
 *
 * PROVENANCE for the invocation and event shapes (docs as of 2026-07):
 *   https://developers.openai.com/codex/noninteractive  (`codex exec`, `--json`
 *     JSONL events, stdin when the positional arg is "-")
 *   https://developers.openai.com/codex/cli/reference   (`--sandbox`,
 *     `--skip-git-repo-check`, `-m/--model`)
 */
export class CodexArm implements Arm {
  readonly harness = "codex";

  private opts: { tiers?: Partial<TierMap>; timeoutMs?: number };

  constructor(opts: { tiers?: Partial<TierMap>; timeoutMs?: number } = {}) {
    this.opts = opts;
  }

  async dispatch(input: DispatchInput, onActivity?: (activity: string) => void): Promise<ArmResult> {
    const tiers = { ...DEFAULT_TIERS, ...this.opts.tiers };
    // GAP: input.allowedTools is intentionally ignored. Codex has no per-invocation
    // allow-list flag (no --allowedTools equivalent); its command allow/deny layer is
    // the execpolicy `.rules` system (~/.codex/rules, <repo>/.codex/rules), which is
    // persistent config rather than argv, so a journal-auditable per-dispatch grant
    // cannot be expressed. See https://developers.openai.com/codex/rules
    const args = [
      "exec",
      "--json",
      "--sandbox", "workspace-write", // write the worktree it owns, nothing beyond it
      "--skip-git-repo-check", // arm worktrees are linked checkouts; don't die on odd git states
      "-m", tiers[input.modelTier],
      "-", // read the prompt from stdin
    ];

    let finalMessage = "";
    let failure = "";
    let usage: unknown;
    const { code, stdout, stderr } = await run("codex", args, {
      cwd: input.worktree,
      stdin: renderPrompt(input),
      timeoutMs: this.opts.timeoutMs ?? 30 * 60 * 1000,
      onLine: (line) => {
        const event = parseLine(line);
        if (!event) return;
        if (event.type === "turn.completed") {
          usage = event.usage;
          return;
        }
        if (event.type === "turn.failed") {
          failure = event.error?.message ?? "codex turn failed";
          return;
        }
        if (event.type === "error") {
          failure = event.message ?? "codex stream error";
          return;
        }
        if ((event.type === "item.started" || event.type === "item.completed") && event.item) {
          // Final answer = the last completed agent_message item's text.
          if (event.type === "item.completed" && event.item.type === "agent_message" && event.item.text) {
            finalMessage = event.item.text;
          }
          const activity = describe(event);
          if (activity) onActivity?.(activity);
        }
      },
    });

    if (code === 0 && !failure && finalMessage) {
      // Codex reports token usage only (turn.completed → usage.{input_tokens,
      // cached_input_tokens,output_tokens,reasoning_output_tokens}); there is no
      // USD figure anywhere in the stream, so costUsd stays unset, not invented.
      return { ok: true, output: finalMessage, raw: { usage } };
    }
    return {
      ok: false,
      output: failure || `${stderr}\n${stdout}`.trim().slice(-3000) || `codex exited with code ${code}`,
    };
  }
}

/** JSONL events from `codex exec --json` — the subset this arm consumes. */
interface CodexEvent {
  type: string;
  item?: {
    type: string;
    text?: string;
    command?: string;
    changes?: { path: string; kind: string }[];
    server?: string;
    tool?: string;
    query?: string;
  };
  usage?: unknown;
  error?: { message?: string };
  message?: string;
}

function parseLine(line: string): CodexEvent | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    return JSON.parse(line) as CodexEvent;
  } catch {
    return null;
  }
}

const shorten = (target: string): string =>
  target.replace(/^.*\/(kraken-[^/]+|worktrees)\//, "").slice(0, 90);

/** One human line per worker step: what tool, on what — or what it said. Mirrors ClaudeArm's describe(). */
function describe(event: CodexEvent): string | null {
  const item = event.item!;
  const started = event.type === "item.started";
  switch (item.type) {
    case "command_execution":
      return started && item.command ? `→ shell ${shorten(item.command)}` : null;
    case "file_change":
      return !started && item.changes?.length
        ? `→ edit ${item.changes.map((c) => shorten(c.path)).join(", ").slice(0, 90)}`
        : null;
    case "mcp_tool_call":
      return started && item.tool ? `→ ${[item.server, item.tool].filter(Boolean).join(".")}` : null;
    case "web_search":
      return started && item.query ? `→ search ${shorten(item.query)}` : null;
    case "agent_message": {
      if (started || !item.text?.trim()) return null;
      const firstLine = item.text.trim().split("\n")[0]!.replace(/^#+\s*/, "").slice(0, 110);
      return firstLine || null;
    }
    default:
      return null;
  }
}
