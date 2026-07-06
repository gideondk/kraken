import { spawn } from "node:child_process";
import type { Arm, ArmResult, DispatchInput, TierMap } from "./arm.ts";
import { renderPrompt } from "./arm.ts";

const DEFAULT_TIERS: TierMap = {
  fast: "haiku",
  standard: "sonnet",
  frontier: "opus",
};

/**
 * Claude Code arm via the documented headless interface, in stream-json mode:
 * every tool call and message the worker makes is surfaced live through
 * onActivity while the run is in flight — arms are not black boxes.
 * Swapping this spawn for the Agent SDK later changes nothing above Arm.
 */
export class ClaudeArm implements Arm {
  readonly harness = "claude-code";

  private opts: { tiers?: Partial<TierMap>; timeoutMs?: number; permissionMode?: string };

  constructor(opts: { tiers?: Partial<TierMap>; timeoutMs?: number; permissionMode?: string } = {}) {
    this.opts = opts;
  }

  async dispatch(input: DispatchInput, onActivity?: (activity: string) => void): Promise<ArmResult> {
    const tiers = { ...DEFAULT_TIERS, ...this.opts.tiers };
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--model", tiers[input.modelTier],
      "--permission-mode", this.opts.permissionMode ?? "acceptEdits",
    ];
    for (const tool of input.allowedTools ?? []) args.push("--allowedTools", tool);

    let final: { result?: string; total_cost_usd?: number; is_error?: boolean } | null = null;
    let lastText = "";
    const { code, stderr, stdout } = await run("claude", args, {
      cwd: input.worktree,
      stdin: renderPrompt(input),
      timeoutMs: this.opts.timeoutMs ?? 30 * 60 * 1000,
      onLine: (line) => {
        const event = parseLine(line);
        if (!event) return;
        if (event.type === "result") {
          final = event as typeof final & { type: string };
          return;
        }
        const activity = describe(event);
        if (activity) {
          if (event.type === "assistant" && !activity.startsWith("→")) lastText = activity;
          onActivity?.(activity);
        }
      },
    });

    if (final) {
      const f = final as { result?: string; total_cost_usd?: number; is_error?: boolean };
      return {
        ok: !f.is_error && code === 0,
        output: f.result ?? lastText,
        raw: f,
        ...(f.total_cost_usd !== undefined ? { costUsd: f.total_cost_usd } : {}),
      };
    }
    return {
      ok: false,
      output: `${stderr}\n${stdout}`.trim().slice(-3000) || `claude exited with code ${code}`,
    };
  }
}

interface StreamEvent {
  type: string;
  message?: { content?: { type: string; text?: string; name?: string; input?: Record<string, unknown> }[] };
  result?: string;
  total_cost_usd?: number;
  is_error?: boolean;
}

function parseLine(line: string): StreamEvent | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    return JSON.parse(line) as StreamEvent;
  } catch {
    return null;
  }
}

/** One human line per worker step: what tool, on what — or what it said. */
function describe(event: StreamEvent): string | null {
  if (event.type !== "assistant" || !event.message?.content) return null;
  for (const block of event.message.content) {
    if (block.type === "tool_use" && block.name) {
      const i = block.input ?? {};
      const target =
        (i.file_path as string) ?? (i.path as string) ?? (i.notebook_path as string) ??
        (i.command as string) ?? (i.pattern as string) ?? (i.query as string) ??
        (i.description as string) ?? "";
      const shortTarget = String(target).replace(/^.*\/(kraken-[^/]+|worktrees)\//, "").slice(0, 90);
      return `→ ${block.name}${shortTarget ? ` ${shortTarget}` : ""}`;
    }
    if (block.type === "text" && block.text?.trim()) {
      const firstLine = block.text.trim().split("\n")[0]!.replace(/^#+\s*/, "").slice(0, 110);
      return firstLine || null;
    }
  }
  return null;
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; stdin?: string; timeoutMs: number; onLine?: (line: string) => void },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let buffer = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      if (!opts.onLine) return;
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) opts.onLine(line);
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buffer && opts.onLine) opts.onLine(buffer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}
