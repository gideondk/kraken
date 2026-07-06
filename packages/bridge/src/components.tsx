import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import hljs from "highlight.js/lib/common";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { elapsed, fetchDiff, waves, type ContractState, type RunState } from "./api";

/* ---------- tinted badge palette (Abyssal Telemetry tokens) ---------- */

type PillColor = "teal" | "cyan" | "yellow" | "red" | "gray";

const PILL: Record<PillColor, { text: string; border: string; bg: string }> = {
  teal: { text: "text-pulse", border: "border-[rgba(60,232,176,0.35)]", bg: "bg-pulse-dim" },
  cyan: { text: "text-sonar", border: "border-[rgba(78,205,230,0.35)]", bg: "bg-[rgba(78,205,230,0.14)]" },
  yellow: { text: "text-warn", border: "border-[rgba(242,185,85,0.4)]", bg: "bg-[rgba(242,185,85,0.14)]" },
  red: { text: "text-danger", border: "border-[rgba(242,109,109,0.4)]", bg: "bg-[rgba(242,109,109,0.14)]" },
  gray: { text: "text-muted-foreground", border: "border-edge", bg: "bg-abyss-raised" },
};

/** Classes for a color-tinted Badge: outline by default, filled tint when `filled`. */
export function pill(color: PillColor, filled = false): string {
  const p = PILL[color];
  return cn("rounded-sm", p.text, p.border, filled && p.bg);
}

const STATUS_COLOR: Record<string, PillColor> = {
  merged: "teal", completed: "teal",
  dispatched: "teal", "at-checkpoint": "cyan", queued: "cyan",
  "awaiting-decision": "yellow", planned: "gray",
  ejected: "red", parked: "gray",
};

export function StatusPill({ status }: { status: string }) {
  const live = ["dispatched", "at-checkpoint", "queued"].includes(status);
  return (
    <Badge variant="outline" className={pill(STATUS_COLOR[status] ?? "gray", live)}>
      {status}
    </Badge>
  );
}

/* ---------- reveal: a lightweight Spoiler replacement ---------- */

export function Reveal({
  maxHeight, showLabel, hideLabel, children,
}: { maxHeight: number; showLabel: string; hideLabel: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOverflow(el.scrollHeight > maxHeight + 4);
  }, [maxHeight, children]);
  return (
    <div>
      <div className="relative">
        <div
          ref={ref}
          className="overflow-hidden transition-[max-height]"
          style={{ maxHeight: open ? undefined : maxHeight }}
        >
          {children}
        </div>
        {/* Clipping reads intentional: fade the last line into the card surface. */}
        {overflow && !open && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8"
            style={{ background: "linear-gradient(to top, var(--card, var(--background)), transparent)" }}
          />
        )}
      </div>
      {overflow && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-1.5 font-mono text-[11px] text-sonar hover:underline"
        >
          {open ? hideLabel : showLabel}
        </button>
      )}
    </div>
  );
}

/* ---------- pipeline graph (bespoke centerpiece, custom Tailwind) ---------- */

export function Pipeline({ run }: { run: RunState }) {
  const cols = waves(run.contracts);
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<{ d: string; hot: boolean }[]>([]);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const rootBox = root.getBoundingClientRect();
    const anchor = (el: Element, side: "left" | "right") => {
      const b = el.getBoundingClientRect();
      return { x: (side === "left" ? b.left : b.right) - rootBox.left, y: b.top + b.height / 2 - rootBox.top };
    };
    const byId = new Map<string, Element>();
    root.querySelectorAll("[data-node]").forEach((el) => byId.set(el.getAttribute("data-node")!, el));
    const head = root.querySelector("[data-head]");
    const next: { d: string; hot: boolean }[] = [];
    const curve = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      `M ${a.x} ${a.y} C ${a.x + (b.x - a.x) / 2} ${a.y}, ${a.x + (b.x - a.x) / 2} ${b.y}, ${b.x} ${b.y}`;
    for (const c of run.contracts) {
      const to = byId.get(c.id);
      if (!to) continue;
      const active = ["dispatched", "at-checkpoint", "queued"].includes(c.status);
      const sources = c.dependsOn.length
        ? c.dependsOn.map((d) => byId.get(d)).filter((x): x is Element => !!x)
        : head ? [head] : [];
      for (const from of sources) next.push({ d: curve(anchor(from, "right"), anchor(to, "left")), hot: active });
    }
    setEdges(next);
  }, [run]);

  return (
    <div className="relative overflow-x-auto px-0.5 pb-2 pt-3">
      <div className="relative min-w-min" ref={ref}>
        <svg className="pointer-events-none absolute inset-0" width="100%" height="100%">
          {edges.map((e, i) => (
            <path
              key={i}
              d={e.d}
              fill="none"
              strokeWidth={1.25}
              className={e.hot
                ? "stroke-pulse opacity-70 animate-pulse [stroke-dasharray:5_6]"
                : "stroke-edge"}
            />
          ))}
        </svg>
        <div className="relative flex gap-[38px] sm:gap-[52px]">
          <div className="flex flex-col justify-center gap-3">
            <div
              data-head
              title="the head"
              className="flex h-[54px] w-[54px] items-center justify-center self-center rounded-full border border-edge bg-abyss-raised text-[22px]"
            >
              ❯_
            </div>
          </div>
          {cols.map((col, i) => (
            <div className="flex flex-col justify-center gap-3" key={i}>
              {col.map((c) => <Node key={c.id} c={c} runId={run.runId} />)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Node({ c, runId }: { c: ContractState; runId: string }) {
  const active = ["dispatched", "at-checkpoint", "queued"].includes(c.status);
  const done = ["completed", "merged"].includes(c.status);
  const bad = c.status === "ejected";
  return (
    <Link to="/run/$runId" params={{ runId }} hash={c.id} className="text-inherit no-underline">
      <div
        data-node={c.id}
        className={cn(
          "relative w-[180px] cursor-pointer rounded-lg border bg-abyss-raised p-[10px_12px]",
          "shadow-[inset_0_1px_0_rgba(232,240,242,0.03)] transition-[border-color,box-shadow] duration-200 sm:w-[210px]",
          "border-edge-faint hover:border-edge-strong",
          done && "border-[rgba(60,232,176,0.18)]",
          bad && "border-[rgba(242,109,109,0.35)]",
          active && "border-[rgba(60,232,176,0.4)] shadow-[0_0_0_1px_rgba(60,232,176,0.25),0_0_14px_rgba(60,232,176,0.14)]",
        )}
      >
        <b className="mb-0.5 block font-mono text-[12.5px] font-medium text-foreground">{c.id}</b>
        <span className="font-mono text-[10px] text-muted-foreground">
          [{c.tier}] {elapsed(c)}{c.costUsd ? ` · $${c.costUsd.toFixed(2)}` : ""}
        </span>
        {active && c.currentActivity && (
          <div className="mt-1.5 max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] text-pulse">
            {c.currentActivity}
          </div>
        )}
        <div className="mt-[7px]"><StatusPill status={c.status} /></div>
        {c.score !== null && (
          <div className="mt-2 h-0.5 overflow-hidden rounded-sm bg-edge-faint" title={`judge ${c.score.toFixed(2)}`}>
            <i className={cn("block h-full rounded-sm", c.score >= 0.7 ? "bg-pulse" : "bg-danger")} style={{ width: `${c.score * 100}%` }} />
          </div>
        )}
      </div>
    </Link>
  );
}

/* ---------- structured diagnostics: the anti-UX-hell renderer ---------- */

interface Diagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  url?: string;
  file?: string;
}

/** Parse MSBuild/NuGet-style diagnostics out of raw gate output. */
export function parseDiagnostics(text: string): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  const rx = /(?:([^\s:]+\.(?:csproj|cs|fs|vb))\s*:?\s*)?(error|warning)\s+([A-Z]{2,4}\d{3,5}):\s*([^\n[]+)/gim;
  for (const m of text.matchAll(rx)) {
    const raw = m[4]!.trim();
    const url = raw.match(/https?:\/\/\S+/)?.[0]?.replace(/[),.\]]+$/, "");
    const message = raw.replace(/,?\s*https?:\/\/\S+/, "").replace(/,\s*$/, "").trim();
    const key = `${m[3]}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      severity: m[2]!.toLowerCase() as Diagnostic["severity"],
      code: m[3]!,
      message,
      ...(url ? { url } : {}),
      ...(m[1] ? { file: m[1].split("/").pop()! } : {}),
    });
  }
  return out;
}

/** Console/diagnostic context: structured cards when parseable, highlighted code otherwise. */
export function ConsoleOut({ text }: { text: string }) {
  const gateHeader = text.match(/gate '([^']+)' failed/)?.[1];
  const diags = parseDiagnostics(text);
  if (diags.length > 0) {
    return (
      <div className="mt-2 flex flex-col gap-1.5">
        {gateHeader && (
          <p className="font-mono text-xs text-muted-foreground">
            gate <code className="rounded bg-abyss-raised px-1 py-0.5 font-mono text-[11px] text-foreground">{gateHeader}</code> failed with:
          </p>
        )}
        {diags.map((d, i) => (
          <div key={i} className="flex flex-nowrap items-baseline gap-2">
            <Badge variant="outline" className={cn(pill(d.severity === "error" ? "red" : "yellow", true), "normal-case")}>
              {d.code}
            </Badge>
            <p className="flex-1 text-sm text-foreground">
              {d.message}
              {d.file && <span className="text-xs text-muted-foreground"> — {d.file}</span>}
              {d.url && (
                <> · <a href={d.url} target="_blank" rel="noreferrer" className="text-xs text-sonar hover:underline">advisory</a></>
              )}
            </p>
          </div>
        ))}
      </div>
    );
  }
  return <HighlightedBlock text={text} />;
}

export function HighlightedBlock({ text }: { text: string }) {
  const html = hljs.highlightAuto(text.slice(0, 4000)).value;
  return (
    <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-edge-faint bg-abyss-bg px-3 py-2.5 font-mono text-[11.5px] leading-relaxed">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

/** Long detail lives behind an accordion — one calm line by default. */
export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Accordion type="single" collapsible className="mt-2">
      <AccordionItem value="detail" className="rounded-md border border-edge-faint bg-abyss-raised px-3">
        <AccordionTrigger className="py-2.5 text-xs normal-case text-muted-foreground">{label}</AccordionTrigger>
        <AccordionContent>{children}</AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

/* ---------- diff ---------- */

const DIFF_LANG: Record<string, string> = {
  cs: "csharp", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  css: "css", json: "json", md: "markdown", toml: "ini", sh: "bash", yml: "yaml", yaml: "yaml", html: "xml",
};

function diffLineHtml(line: string, lang?: string): string {
  if (!lang || line.startsWith("@@")) {
    return line.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  }
  try {
    return hljs.highlight(line, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return line.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  }
}

export function Diff({ runId, contractId }: { runId: string; contractId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["diff", runId, contractId],
    queryFn: () => fetchDiff(runId, contractId),
  });
  if (isLoading) return <p className="text-xs text-muted-foreground">loading diff…</p>;
  if (!data?.trim() || data.startsWith("no diff")) return null;

  const files: { header: string; adds: number; dels: number; lines: string[] }[] = [];
  for (const line of data.split("\n")) {
    if (line.startsWith("diff --git")) {
      files.push({ header: line.split(" b/").pop() ?? line, adds: 0, dels: 0, lines: [] });
      continue;
    }
    const f = files[files.length - 1];
    if (!f) continue;
    f.lines.push(line);
    if (line.startsWith("+") && !line.startsWith("+++")) f.adds++;
    if (line.startsWith("-") && !line.startsWith("---")) f.dels++;
  }
  return (
    <Accordion type="multiple" className="mt-2.5 flex flex-col gap-1.5">
      {files.map((f, i) => (
        <AccordionItem value={f.header + i} key={i} className="rounded-md border border-edge-faint bg-abyss-bg px-3">
          <AccordionTrigger className="py-2.5 normal-case">
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-xs text-foreground">{f.header}</span>
              <span className="font-mono text-xs text-pulse">+{f.adds}</span>
              <span className="font-mono text-xs text-danger">−{f.dels}</span>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <div className="overflow-x-auto font-mono text-[11.5px] leading-[1.55]">
              {f.lines
                .filter((l) => !l.startsWith("index ") && !l.startsWith("+++") && !l.startsWith("---"))
                .map((l, j) => {
                  const lang = DIFF_LANG[f.header.split(".").pop() ?? ""];
                  const marker = l.startsWith("+") || l.startsWith("-") ? l[0] : " ";
                  const body = l.startsWith("@@") ? l : l.slice(1);
                  return (
                    <div
                      key={j}
                      className={cn(
                        "flex min-w-max whitespace-pre px-1 text-foreground/80",
                        l.startsWith("+") && "bg-[rgba(5,150,105,0.10)]",
                        l.startsWith("-") && "bg-[rgba(220,38,38,0.09)]",
                        l.startsWith("@@") && "bg-muted py-0.5 text-muted-foreground",
                      )}
                    >
                      <span className={cn("w-4 shrink-0 select-none text-center",
                        marker === "+" ? "text-pulse" : marker === "-" ? "text-danger" : "text-transparent")}>{marker}</span>
                      <span dangerouslySetInnerHTML={{ __html: diffLineHtml(body, lang) || " " }} />
                    </div>
                  );
                })}
            </div>
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

/* ---------- activity: a real timeline, not a wall ---------- */

const LEVEL_DOT: Record<string, string> = {
  ok: "bg-pulse", warn: "bg-warn", bad: "bg-danger", info: "bg-muted-foreground",
};

export function Feed({ items }: { items: { at: string; text: string; level: string }[] }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">Nothing yet.</p>;
  const shown = items.slice(0, 30);
  return (
    <Reveal maxHeight={420} showLabel="Show earlier activity" hideLabel="Collapse">
      <div className="relative">
        {shown.length > 1 && <span className="absolute bottom-2 left-[4px] top-2 w-px bg-edge" />}
        <div className="flex flex-col">
          {shown.map((f, i) => (
            <div key={i} className="relative flex items-baseline gap-2.5 pb-2">
              <span
                className={cn(
                  "mt-[5px] h-[9px] w-[9px] shrink-0 rounded-full ring-2 ring-abyss-bg",
                  LEVEL_DOT[f.level] ?? "bg-muted-foreground",
                )}
              />
              <div className="flex flex-nowrap items-baseline gap-2.5">
                <time className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                  {new Date(f.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                </time>
                <span className={cn("max-w-[90ch] text-sm leading-relaxed", f.level === "bad" || f.level === "warn" ? "text-foreground/90" : "text-foreground/70")}>
                  {f.text}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

/* ---------- the kraken, pixel style ---------- */

const KRAKEN_GRID = [
  "...#####...",
  "..#######..",
  ".#########.",
  ".##.###.##.",
  ".#########.",
  ".#########.",
  "..#.#.#.#..",
  "..#.#.#.#..",
  ".#..#.#..#.",
];

export function KrakenMark({ size = 28, color = "#1E293B" }: { size?: number; color?: string }) {
  const rects: { x: number; y: number }[] = [];
  KRAKEN_GRID.forEach((row, y) => {
    [...row].forEach((ch, x) => { if (ch === "#") rects.push({ x, y }); });
  });
  return (
    <svg width={size} height={size} viewBox="0 0 15 15" shapeRendering="crispEdges" aria-label="Kraken">
      <rect x="0" y="0" width="15" height="15" rx="3.4" fill={color} />
      {rects.map((r, i) => (
        <rect key={i} x={r.x + 2} y={r.y + 3} width="1.02" height="1.02" fill="rgba(255,255,255,0.94)" />
      ))}
    </svg>
  );
}
