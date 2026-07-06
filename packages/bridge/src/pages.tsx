import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent, type MouseEvent as RMouseEvent, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  abortCampaign, advanceCampaign, ask, decide, execRun, fetchChat, fetchState, sendChat, startRun,
  type Campaign, type CampaignSlice, type ChatMsg, type Decision, type HelmState, type RunState,
  startCampaign, waves,
} from "./api";
import { ConsoleOut, Detail, Diff, Feed, KrakenMark, Pipeline, Reveal, StatusPill, pill } from "./components";

export const useBridge = () =>
  useQuery<HelmState>({ queryKey: ["state"], queryFn: fetchState, refetchInterval: 4000 });


/* ---------- tiny inline icons ---------- */
const Ic = {
  target: (c: string) => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.2">
      <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="0.5" fill={c} />
    </svg>
  ),
  shield: (c: string) => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.2">
      <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
    </svg>
  ),
  check: (c: string) => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.2">
      <rect x="4" y="4" width="16" height="16" rx="4" /><path d="M9 12.5l2.2 2.2L15.5 10" />
    </svg>
  ),
  checkbox: (c: string) => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" style={{ flexShrink: 0, marginTop: 3 }}>
      <rect x="4" y="4" width="16" height="16" rx="4" />
    </svg>
  ),
};

const BRIEF_META = {
  objectives: { label: "objectives", color: "#2563eb", icon: Ic.target },
  constraints: { label: "constraints", color: "#b45309", icon: Ic.shield },
  doneWhen: { label: "done when", color: "#059669", icon: Ic.check },
} as const;

/* ---------- anchored annotations: quotes highlight in place ---------- */
function extractQuotes(note?: string): string[] {
  if (!note) return [];
  return [...note.matchAll(/^> "(.+?)"/gm)].map((m) => m[1]!).filter((q) => q.length > 2);
}

function Marked({ text, quotes, onClick }: { text: string; quotes: string[]; onClick?: (e: RMouseEvent) => void }) {
  if (quotes.length === 0) return <>{text}</>;
  let parts: ReactNode[] = [text];
  quotes.forEach((q, qi) => {
    parts = parts.flatMap((part) => {
      if (typeof part !== "string") return [part];
      const segs = part.split(q);
      if (segs.length === 1) return [part];
      const out: ReactNode[] = [];
      segs.forEach((seg, si) => {
        out.push(seg);
        if (si < segs.length - 1) out.push(
          <mark key={`${qi}-${si}`} onClick={onClick}
            className="cursor-pointer rounded-sm bg-[rgba(242,185,85,0.3)] px-0.5 transition-colors hover:bg-[rgba(242,185,85,0.5)]">
            {q}
          </mark>,
        );
      });
      return out;
    });
  });
  return <>{parts.map((part, i) => (typeof part === "string" ? <span key={`m${i}`}>{md(part)}</span> : part))}</>;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2.5 mt-7 font-mono text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
      {children}
    </h2>
  );
}

/** Grow a textarea to fit its content — a small autosize shim. */
const autoGrow = (e: FormEvent<HTMLTextAreaElement>) => {
  const t = e.currentTarget;
  t.style.height = "auto";
  t.style.height = `${t.scrollHeight}px`;
};

/* ---------- Fleet (home) ---------- */

export function FleetPage() {
  const { data } = useBridge();
  if (!data) return null;
  const openDecisions = data.decisions.filter((d) => !d.decisionId.startsWith("plan-"));
  return (
    <>
      {openDecisions.length > 0 && (
        <>
          <SectionTitle>Decisions · {openDecisions.length}</SectionTitle>
          <div className="flex flex-col gap-2.5">{openDecisions.map((d) => <DecisionCard key={d.decisionId} d={d} />)}</div>
        </>
      )}
      <SectionTitle>Fleet</SectionTitle>
      {data.runs.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No runs yet — describe an outcome in the prompt bar below.
        </p>
      )}
      <div className="flex flex-col gap-3">
        {data.runs.map((r) => (
          <Card key={r.runId} className="p-4">
            <div className="flex flex-nowrap items-start justify-between gap-3">
              <Link to="/run/$runId" params={{ runId: r.runId }} className="min-w-0 flex-1 text-inherit no-underline">
                <p className="font-mono text-xs text-muted-foreground">{r.runId}</p>
                <p className="mt-0.5 line-clamp-2 text-sm text-foreground">{r.goal}</p>
              </Link>
              <Badge
                variant="outline"
                className={pill(r.outcome === "success" ? "teal" : r.outcome ? "yellow" : r.approved ? "cyan" : "yellow")}
              >
                {r.outcome ?? (r.contracts.length === 0 ? "planning\u2026" : r.approved ? "running" : "plan review")}
              </Badge>
            </div>
            <Pipeline run={r} />
            {!r.approved && !r.outcome && <PlanReview run={r} decisions={data.decisions} />}
          </Card>
        ))}
      </div>
      <SectionTitle>Activity</SectionTitle>
      <Feed items={data.feed} />
    </>
  );
}

/* ---------- Plan review: ack / adjust / decline ---------- */

function ArmDetail({ c, runId }: { c: RunState["contracts"][number]; runId: string }) {
  return (
    <>
            {c.skills.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {c.skills.map((s) => <Badge key={s} variant="outline" className={pill("cyan", true)}>{s}</Badge>)}
              </div>
            )}
            {c.score !== null && (
              <div className="mt-2 flex flex-nowrap items-baseline gap-2">
                <Badge variant="outline" className={pill(c.score >= 0.7 ? "teal" : "red", true)}>
                  judge {c.score.toFixed(2)}
                </Badge>
                <Reveal maxHeight={44} showLabel="more" hideLabel="less">
                  <p className="max-w-[75ch] text-sm leading-relaxed text-muted-foreground">{c.rationale}</p>
                </Reveal>
              </div>
            )}
            {c.report && (
              <div className="mt-2 space-y-2">
                <p className="max-w-[75ch] text-sm leading-relaxed text-foreground/90">{c.report.summary}</p>
                {([
                  ["decisions", c.report.decisions],
                  ["gotchas", c.report.gotchas],
                  ["interface changes", c.report.interfaceChanges],
                  ["blockers", c.report.blockers],
                ] as const).map(([label, items]) => items.length > 0 && (
                  <div key={label}>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
                    <ul className="mt-0.5 list-disc pl-4 text-[13px] text-foreground/80">
                      {items.map((it, i) => <li key={i}>{md(it)}</li>)}
                    </ul>
                  </div>
                ))}
                {c.report.filesTouched.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {c.report.filesTouched.slice(0, 8).map((f) => (
                      <span key={f} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{f.split("/").pop()}</span>
                    ))}
                    {c.report.filesTouched.length > 8 && <span className="font-mono text-[10px] text-muted-foreground">+{c.report.filesTouched.length - 8}</span>}
                  </div>
                )}
              </div>
            )}
            {c.score !== null && c.score >= 0.7 && c.ejectReason && (
              <p className="mt-1 max-w-[75ch] text-xs leading-relaxed text-muted-foreground">
                Passed the judge in isolation — failed the integration gates on the merge train. These verify different things; the train is the stricter of the two.
              </p>
            )}
            {c.mustFix.length > 0 && c.score !== null && c.score < 0.7 && (
              <div className="mt-1">
                <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">required fixes</div>
                <ul className="mt-0.5 list-disc pl-4 text-[13px] text-foreground/80">
                  {c.mustFix.map((f, i) => <li key={i}>{md(f)}</li>)}
                </ul>
              </div>
            )}
            {c.ejectReason && (
              <Detail label="Ejected from the merge train — why">
                <ConsoleOut text={c.ejectReason} />
              </Detail>
            )}
            {c.activityLog.length > 0 && ["dispatched", "at-checkpoint"].includes(c.status) && (
              <div className="my-2.5 border-l border-edge pl-3 font-mono text-[10.5px] text-muted-foreground">
                {c.activityLog.slice(-8).map((a, i) => (
                  <div key={i} className="overflow-hidden text-ellipsis whitespace-nowrap py-px last:text-pulse">{a}</div>
                ))}
              </div>
            )}
            {c.branch && <Diff runId={runId} contractId={c.id} />}
    </>
  );
}

function PlanReview({ run, decisions, notesExt, setNotesExt, onPlanEditorOpen }: {
  run: RunState; decisions: Decision[];
  notesExt?: Record<string, string>;
  setNotesExt?: (updater: (n: Record<string, string>) => Record<string, string>) => void;
  onPlanEditorOpen?: (x: number, y: number) => void;
}) {
  const planDecision = decisions.find((d) => d.decisionId === `plan-${run.runId}`);
  const qc = useQueryClient();
  const nav = useNavigate();
  const [notesInt, setNotesInt] = useState<Record<string, string>>({});
  const notes = notesExt ?? notesInt;
  const setNotes = (v: Record<string, string> | ((n: Record<string, string>) => Record<string, string>)) => {
    const updater = typeof v === "function" ? v : () => v;
    (setNotesExt ?? setNotesInt)(updater as (n: Record<string, string>) => Record<string, string>);
  };
  const [noting, setNoting] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<{ id: string; text: string; x: number; y: number } | null>(null);
  const review = !!planDecision;

  useEffect(() => {
    if (!review) return;
    const onMouseUp = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) { setSel(null); return; }
      const text = selection.toString().trim().slice(0, 280);
      const node = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
      const row = node?.closest?.("[data-contract]");
      const brief = node?.closest?.("[data-brief]");
      if (!text || (!row && !brief)) { setSel(null); return; }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      setSel({ id: row ? row.getAttribute("data-contract")! : "__plan", text, x: rect.left + rect.width / 2, y: rect.top });
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSel(null); };
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keydown", onKey);
    };
  }, [review]);
  const annotateSelection = () => {
    if (!sel) return;
    const quoted = `> "${sel.text}"\n`;
    setNotes((n) => ({ ...n, [sel.id]: `${n[sel.id] ? n[sel.id] + "\n" : ""}${quoted}` }));
    if (sel.id === "__plan" && onPlanEditorOpen) onPlanEditorOpen(sel.x, sel.y);
    else {
      setOpen((o) => ({ ...o, [sel.id]: true }));
      setNoting((x) => ({ ...x, [sel.id]: true }));
    }
    window.getSelection()?.removeAllRanges();
    setSel(null);
  };

  const cols = waves(run.contracts);
  const numbered = cols.flatMap((col, w) => col.map((c) => ({ c, wave: w })));
  const num = new Map(numbered.map((x, i) => [x.c.id, i + 1]));
  const { data: allState } = useBridge();
  const inFlight = new Map<string, string>();
  for (const other of allState?.runs ?? []) {
    if (other.runId === run.runId || (other.outcome && other.outcome !== "partial") || other.repo !== run.repo) continue;
    for (const oc of other.contracts) {
      if (["merged", "parked"].includes(oc.status)) continue;
      for (const path of oc.ownsPaths) inFlight.set(path, other.title ?? other.runId);
    }
  }
  const pathOwners = new Map<string, string[]>();
  for (const c of run.contracts) for (const path of c.ownsPaths) {
    pathOwners.set(path, [...(pathOwners.get(path) ?? []), c.id]);
  }
  const savedNotes = Object.entries(notes).filter(([, v]) => v.trim());
  const annotation = () => savedNotes.map(([k, v]) => k === "__plan" ? `plan: ${v.trim()}` : `#${num.get(k)} ${k}: ${v.trim()}`).join(" | ");

  const approve = async () => {
    setBusy(true);
    await decide(run.runId, planDecision!.decisionId, "approve", annotation());
    // Campaign slices auto-advance server-side on approval — a second exec here would double-dispatch.
    if (!run.campaign) await execRun(run.runId);
    qc.invalidateQueries({ queryKey: ["state"] });
  };
  const replan = async () => {
    setBusy(true);
    await decide(run.runId, planDecision!.decisionId, "replan", annotation());
    const revision = savedNotes.map(([k, v]) => k === "__plan" ? `- plan-level: ${v.trim()}` : `- ${k}: ${v.trim()}`).join("\n");
    await startRun(`${run.goal}\n\nReviewer notes on the previous plan (address these):\n${revision}`, run.repo);
    qc.invalidateQueries({ queryKey: ["state"] });
    nav({ to: "/" });
  };
  const decline = async () => {
    setBusy(true);
    await decide(run.runId, planDecision!.decisionId, "reject", annotation());
    qc.invalidateQueries({ queryKey: ["state"] });
  };

  const TIER_DOT: Record<string, string> = { fast: "bg-muted-foreground", standard: "bg-sonar", frontier: "bg-[#0D9488]" };
  const MEDAL: Record<string, string> = {
    merged: "bg-[rgba(5,150,105,0.14)] text-pulse",
    completed: "bg-[rgba(5,150,105,0.14)] text-pulse",
    dispatched: "bg-[rgba(5,150,105,0.14)] text-pulse animate-pulse",
    "at-checkpoint": "bg-[rgba(37,99,235,0.12)] text-sonar",
    parked: "bg-[rgba(180,83,9,0.12)] text-warn",
    "awaiting-decision": "bg-[rgba(180,83,9,0.12)] text-warn",
    failed: "bg-[rgba(220,38,38,0.12)] text-danger",
    ejected: "bg-[rgba(220,38,38,0.12)] text-danger",
  };

  return (
    <div className="mt-3">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{review ? "Plan review — " : "Tasks — "}{run.contracts.length}</p>
      {run.contracts.length === 0 && !run.outcome && (
        <div className="mt-2 flex items-center gap-2.5 rounded-lg border border-border bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-sonar" />
          The head is planning — decomposing the goal into tasks. This usually takes a minute or two.
        </div>
      )}
      {sel && (
        <button
          className="fixed z-50 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium shadow-md"
          style={{ left: sel.x, top: sel.y - 6 }}
          onMouseDown={(e) => { e.preventDefault(); annotateSelection(); }}
        >
          💬 {sel.id === "__plan" ? "annotate plan" : `annotate #${num.get(sel.id)}`}
        </button>
      )}
      {!onPlanEditorOpen && (noting.__plan || notes.__plan) && (
        <div className="mt-2">
          <div className="font-mono text-[10px] uppercase tracking-widest text-warn">plan note</div>
          <Textarea autoFocus className="mt-1 min-h-[40px] text-[13px]"
            placeholder="feedback on the brief or the plan as a whole…"
            value={notes.__plan ?? ""}
            onChange={(e) => setNotes({ ...notes, __plan: e.target.value })} />
        </div>
      )}
      <div className="mt-2 overflow-hidden rounded-lg border border-border">
        {numbered.map(({ c, wave }, i) => {
          const isOpen = !!open[c.id];
          const hasNote = !!notes[c.id]?.trim();
          const conflicts = c.ownsPaths.filter((path) => (pathOwners.get(path) ?? []).length > 1);
          const showWave = i === 0 || numbered[i - 1]!.wave !== wave;
          return (
            <div key={c.id}>
              {showWave && (
                <div className="border-b border-border bg-muted/60 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Wave {wave + 1}{wave === 0 ? " — runs immediately" : ` — after ${cols[wave - 1]!.map((d) => `#${num.get(d.id)}`).join(", ")}`}
                </div>
              )}
              <div id={c.id} data-contract={c.id} className={cn("group border-b border-border last:border-b-0", isOpen && "bg-muted/30")}>
                <button className="flex w-full items-start gap-3 px-3 py-2.5 text-left" onClick={() => setOpen({ ...open, [c.id]: !isOpen })}>
                  <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] tabular-nums",
                    review ? "bg-muted text-muted-foreground group-hover:bg-border" : (MEDAL[c.status] ?? "bg-muted text-muted-foreground"))}>{num.get(c.id)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      <Marked text={c.objective} quotes={extractQuotes(notes[c.id])}
                        onClick={(e) => { e.stopPropagation(); setOpen({ ...open, [c.id]: true }); setNoting({ ...noting, [c.id]: true }); }} />
                    </span>
                    <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      {c.dependsOn.length > 0 && <span>after {c.dependsOn.map((d) => `#${num.get(d)}`).join(", ")}</span>}
                      {!review && c.currentActivity && ["dispatched", "at-checkpoint"].includes(c.status)
                        ? <span className="truncate font-mono text-[11px] text-pulse">{c.currentActivity}</span>
                        : <span className="truncate font-mono text-[11px]">{c.ownsPaths[0]}{c.ownsPaths.length > 1 ? ` +${c.ownsPaths.length - 1}` : ""}</span>}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
                    {review && hasNote && <Badge variant="outline" className="border-warn/40 text-warn">1 note</Badge>}
                    {review && conflicts.length > 0 && <Badge variant="outline" className="border-warn/40 text-warn">path overlap</Badge>}
                    {review && c.ownsPaths.some((path) => inFlight.has(path)) && (
                      <Badge variant="outline" className="border-danger/40 text-danger" title={`another active run owns: ${c.ownsPaths.filter((x) => inFlight.has(x)).map((x) => `${x} (${inFlight.get(x)})`).join(", ")}`}>
                        in-flight overlap
                      </Badge>
                    )}
                    <Badge variant="outline" className="gap-1 font-mono text-[10px]">
                      <span className={cn("h-1.5 w-1.5 rounded-full", TIER_DOT[c.tier] ?? "bg-muted-foreground")} />{c.tier}
                    </Badge>
                    {review ? (
                      <Badge variant="outline" className="font-mono text-[10px]">{c.ownsPaths.length} path{c.ownsPaths.length > 1 ? "s" : ""}</Badge>
                    ) : (
                      <>
                        {c.score !== null && <Badge variant="outline" className={pill(c.score >= 0.7 ? "teal" : "red", true)}>judge {c.score.toFixed(2)}</Badge>}
                        {c.costUsd && <span className="font-mono text-[11px] text-muted-foreground">${c.costUsd.toFixed(2)}</span>}
                        <StatusPill status={c.status} />
                      </>
                    )}
                  </span>
                </button>
                {isOpen && !review && (
                  <div className="px-3 pb-3 pl-10">
                    <ArmDetail c={c} runId={run.runId} />
                  </div>
                )}
                {isOpen && review && (
                  <div className="space-y-3 px-3 pb-3 pl-10">
                    {c.outputFormat && c.outputFormat !== c.objective && (
                      <div>
                        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">shape of done</div>
                        <div className="mt-0.5 max-w-[80ch] space-y-1.5 text-[13px] leading-relaxed text-foreground/85">
                          <Prose text={c.outputFormat}
                            wrap={(t) => <Marked text={t} quotes={extractQuotes(notes[c.id])}
                              onClick={() => { setNoting({ ...noting, [c.id]: true }); }} />} />
                        </div>
                      </div>
                    )}
                    {c.keyRisks.length > 0 && (
                      <div>
                        <div className="font-mono text-[10px] uppercase tracking-widest text-warn">key risks</div>
                        <ul className="mt-0.5 list-disc pl-4 text-[13px] leading-snug text-foreground/85">
                          {c.keyRisks.map((r, i) => <li key={i}>{md(r)}</li>)}
                        </ul>
                      </div>
                    )}
                    <div>
                      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">owns</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {c.ownsPaths.map((path) => (
                          <span key={path} className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]", conflicts.includes(path) ? "text-warn ring-1 ring-warn/40" : "text-muted-foreground")}>{path}</span>
                        ))}
                      </div>
                    </div>
                    {noting[c.id] || hasNote ? (
                      <div>
                        <Textarea autoFocus className="min-h-[40px] text-[13px]"
                          placeholder="strike, tighten, or redirect this task…"
                          value={notes[c.id] ?? ""}
                          onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })} />
                      </div>
                    ) : (
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setNoting({ ...noting, [c.id]: true })}>
                        + annotate
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {review && <div className="sticky bottom-2 z-10 mt-3 flex items-center gap-3 rounded-lg border border-border bg-background/80 px-3 py-2 shadow-[0_4px_16px_rgba(15,23,42,0.08)] backdrop-blur-md">
        <span className="flex-1 font-mono text-[11px] text-muted-foreground">
          {run.contracts.length} tasks · {cols.length} wave{cols.length > 1 ? "s" : ""}{savedNotes.length > 0 ? ` · ${savedNotes.length} annotated` : ""}
        </span>
        <Button size="sm" disabled={busy} onClick={approve}>
          {savedNotes.length > 0 ? `Approve with ${savedNotes.length} note${savedNotes.length > 1 ? "s" : ""}` : "Approve & launch"}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={replan} title={savedNotes.length === 0 ? "add notes so the planner knows what to change" : undefined}>
          Request replan
        </Button>
        <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={decline}>Decline</Button>
      </div>}
    </div>
  );
}

/* ---------- Decision card: one calm sentence, detail on demand ---------- */

function DecisionCard({ d }: { d: Decision }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  return (
    <Card className="border-t-2 border-t-warn border-[rgba(242,185,85,0.28)] bg-[linear-gradient(rgba(242,185,85,0.06),transparent_70%)] p-4">
      <div className="mb-1 flex items-center justify-between">
        {d.contractId && <span className="font-mono text-xs text-muted-foreground">{d.contractId}</span>}
        <Badge variant="outline" className={pill("yellow", true)}>needs you</Badge>
      </div>
      <p className="text-sm text-foreground">{md(d.question)}</p>
      {d.suggestedTools && d.suggestedTools.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted-foreground">choosing <span className="font-medium text-foreground/80">retry-with-tools</span> lets the arm run:</span>
          {d.suggestedTools.map((t) => (
            <span key={t} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{t}</span>
          ))}
        </div>
      )}
      {d.context.trim() && (
        <Detail label="Why — distilled context">
          <ConsoleOut text={d.context} />
        </Detail>
      )}
      <Textarea
        className="mt-3 min-h-[34px] text-xs"
        placeholder="optional steering note — travels with your choice into the repair arm's contract"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {d.options.map((o, i) => (
          <Button
            key={o}
            size="sm"
            variant={i === 0 ? "default" : "outline"}
            disabled={busy}
            onClick={async () => { setBusy(true); await decide(d.runId, d.decisionId, o, note); qc.invalidateQueries({ queryKey: ["state"] }); }}
          >
            {o}
          </Button>
        ))}
      </div>
    </Card>
  );
}

/* ---------- Run detail ---------- */

export function RunPage() {
  const { runId } = useParams({ from: "/run/$runId" });
  const { data } = useBridge();
  const qc = useQueryClient();
  const [planNotes, setPlanNotes] = useState<Record<string, string>>({});
  const [planEditor, setPlanEditor] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!planEditor) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPlanEditor(null); };
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.("[data-plan-editor]")) setPlanEditor(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [planEditor]);
  const run = data?.runs.find((r) => r.runId === runId);
  if (!run) return <p className="text-sm text-muted-foreground">Loading run…</p>;
  const runFeed = data!.feed.filter((f) => f.text.includes(runId) || run.contracts.some((c) => f.text.includes(c.id)));
  const decisionsHere = data!.decisions.filter((d) => d.runId === runId && !d.decisionId.startsWith("plan-"));
  return (
    <>
      <Card className="p-4">
        <p className="font-mono text-xs text-muted-foreground">
          {run.runId} · {run.repo}
          {run.campaign && (
            <>
              {" · "}
              <Link to="/campaign" search={{ id: run.campaign }} className="text-sonar hover:underline">
                part of campaign {run.campaign} →
              </Link>
            </>
          )}
        </p>
        {run.title && <h1 className="mt-1 text-[17px] font-semibold leading-snug">{run.title}</h1>}
        {run.brief ? (
          <div data-brief="" className="mt-3 grid overflow-hidden rounded-lg border border-border/70 bg-muted/20 sm:grid-cols-3 sm:divide-x sm:divide-border/70">
            {(["objectives", "constraints", "doneWhen"] as const).map((key) => {
              const meta = BRIEF_META[key];
              const items = run.brief![key];
              if (items.length === 0) return null;
              return (
                <div key={key} className="p-4">
                  <div className="flex items-center gap-1.5">
                    <span className="flex h-5 w-5 items-center justify-center rounded" style={{ background: `${meta.color}14` }}>
                      {meta.icon(meta.color)}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-widest" style={{ color: meta.color }}>{meta.label}</span>
                  </div>
                  <ul className="mt-2 space-y-1.5 text-[13px] leading-snug text-foreground/85">
                    {items.map((it, i) => (
                      <li key={i} className="flex gap-1.5">
                        {key === "doneWhen"
                          ? Ic.checkbox(meta.color)
                          : <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: `${meta.color}66` }} />}
                        <Marked text={it} quotes={extractQuotes(planNotes.__plan)}
                          onClick={(e) => setPlanEditor({ x: e.clientX, y: e.clientY })} />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        ) : (
          <Reveal maxHeight={46} showLabel="more" hideLabel="less">
            <p className="mt-1 max-w-[75ch] text-sm leading-relaxed text-muted-foreground">{run.goal}</p>
          </Reveal>
        )}
        <div className="mt-3 overflow-hidden rounded-lg border border-border/60 bg-muted/20">
          <div className="border-b border-border/60 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">fleet</div>
          <Pipeline run={run} />
        </div>
        {run.approved && !run.outcome && (
          <div className="mt-1.5 flex">
            <Button
              size="sm"
              variant="outline"
              onClick={async () => { await execRun(run.runId); qc.invalidateQueries({ queryKey: ["state"] }); }}
            >
              Reconcile
            </Button>
          </div>
        )}
      </Card>
      {(
        <Card className="mt-3 p-4">
          <PlanReview run={run} decisions={data!.decisions}
            notesExt={planNotes}
            setNotesExt={(u) => setPlanNotes(u)}
            onPlanEditorOpen={(x, y) => setPlanEditor({ x, y })} />
        </Card>
      )}
      {decisionsHere.length > 0 && (
        <>
          <SectionTitle>Decisions · {decisionsHere.length}</SectionTitle>
          <div className="flex flex-col gap-2.5">{decisionsHere.map((d) => <DecisionCard key={d.decisionId} d={d} />)}</div>
        </>
      )}

      {planEditor && (
        <div data-plan-editor="" className="fixed z-50 w-80 -translate-x-1/2 rounded-lg border border-border bg-card p-2 shadow-lg"
          style={{ left: Math.min(Math.max(planEditor.x, 170), window.innerWidth - 170), top: Math.min(planEditor.y + 10, window.innerHeight - 180) }}>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-warn">plan note</div>
          <Textarea autoFocus className="min-h-[60px] text-[13px]"
            placeholder="comment on the highlighted text…"
            value={planNotes.__plan ?? ""}
            onChange={(e) => setPlanNotes({ ...planNotes, __plan: e.target.value })} />
          <div className="mt-1.5 flex justify-end">
            <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => setPlanEditor(null)}>done</Button>
          </div>
        </div>
      )}
      <SectionTitle>Run activity</SectionTitle>
      <Feed items={runFeed} />
    </>
  );
}

/* ---------- New task: the composer ---------- */

export function NewRunPage() {
  const { data } = useBridge();
  const nav = useNavigate();
  const [goal, setGoal] = useState("");
  const [repo, setRepo] = useState(data?.runs[0]?.repo ?? "");
  const [sent, setSent] = useState(false);
  return (
    <>
      <SectionTitle>Send the head a task</SectionTitle>
      <Card className="p-4">
        <div className="flex flex-col gap-3">
          <Textarea
            rows={5}
            onInput={autoGrow}
            autoFocus
            className="resize-none text-sm"
            placeholder="Describe the outcome — intent, constraints, what done looks like. The head plans it into tasks; you review the plan before anything runs."
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
          <Input
            placeholder="/absolute/path/to/repo"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={!goal.trim() || !repo.trim() || sent}
              onClick={async () => {
                setSent(true);
                await startRun(goal.trim(), repo.trim());
                setTimeout(() => nav({ to: "/" }), 800);
              }}
            >
              {sent ? "Planning…" : "Plan it"}
            </Button>
            <span className="text-xs text-muted-foreground">
              The frontier model reads the repo and decomposes the goal (~1–2 min); the plan returns for your review.
            </span>
          </div>
        </div>
      </Card>
      {(data?.runs.length ?? 0) > 0 && (
        <>
          <SectionTitle>Previous tasks</SectionTitle>
          <div className="flex flex-col gap-2">
            {data!.runs.map((r) => (
              <Link to="/run/$runId" params={{ runId: r.runId }} key={r.runId} className="text-inherit no-underline">
                <Card className="p-3">
                  <p className="font-mono text-xs text-muted-foreground">{r.runId} · {r.outcome ?? "open"}</p>
                  <p className="line-clamp-1 text-sm text-foreground">{r.goal}</p>
                </Card>
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}


/* ---------- v2 shell: sessions sidebar, home, docked composer ---------- */

const STATUS_DOT: Record<string, string> = {
  success: "bg-pulse", partial: "bg-warn", running: "bg-pulse animate-pulse",
  "plan review": "bg-warn", "planning\u2026": "bg-sonar animate-pulse", declined: "bg-muted-foreground", replanned: "bg-sonar/50", aborted: "bg-danger/60",
};
const SETTLED = new Set(["success", "declined", "replanned", "aborted"]);

function runStatus(r: RunState): string {
  return r.outcome ?? (r.contracts.length === 0 ? "planning\u2026" : r.approved ? "running" : "plan review");
}

export function Sidebar({ open = false, onNavigate }: { open?: boolean; onNavigate?: () => void } = {}) {
  const { data } = useBridge();
  const [showArchive, setShowArchive] = useState(false);
  const byRepo = new Map<string, RunState[]>();
  const archived: RunState[] = [];
  const repoPathByKey = new Map<string, string>();
  for (const p of data?.projects ?? []) {
    const key = p.split("/").pop() ?? p;
    repoPathByKey.set(key, p);
    if (!byRepo.has(key)) byRepo.set(key, []);
  }
  for (const r of data?.runs ?? []) {
    if (r.outcome && SETTLED.has(r.outcome)) { archived.push(r); continue; }
    const key = r.repo.split("/").pop() ?? r.repo;
    byRepo.set(key, [...(byRepo.get(key) ?? []), r]);
  }
  const pending = data?.decisions.length ?? 0;
  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <Link to="/" className="brand">
        <KrakenMark size={30} />
        <span className="wordmark">Kraken</span>
      </Link>
      {pending > 0 && (
        <Link to="/decisions" onClick={onNavigate}
          className="mt-3 block rounded-md border border-[rgba(242,185,85,0.3)] px-3 py-2 font-mono text-xs text-warn hover:bg-muted">
          {pending} decision{pending > 1 ? "s" : ""} waiting →
        </Link>
      )}
      <div className="mt-4 flex-1 overflow-y-auto">
        {(data?.campaigns?.length ?? 0) > 0 && (
          <div className="mb-4">
            <div className="mb-1 px-1 font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">campaigns</div>
            {data!.campaigns.map((c) => {
              const done = c.slices.filter((s) => s.childOutcome === "success" || s.childOutcome === "partial").length;
              const live = c.slices.some((s) => ["running", "planning"].includes(s.childStatus));
              const review = c.slices.some((s) => s.childStatus === "plan review");
              const settled = !!c.outcome; // any outcome — success, partial or aborted — reads as done
              return (
                <Link key={c.id} to="/campaign" search={{ id: c.id }} onClick={onNavigate}
                  className={cn("sidebar-item", settled && "opacity-55")}
                  activeProps={{ className: cn("sidebar-item active", settled && "opacity-55") }}>
                  <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                    settled
                      ? c.outcome === "success" ? "bg-pulse" : c.outcome === "partial" ? "bg-warn" : "bg-danger/60"
                      : live ? "bg-pulse animate-pulse" : review ? "bg-warn" : "bg-muted-foreground")} />
                  <span className="flex-1 overflow-hidden">
                    <span className="block truncate text-[13px] leading-snug">{c.title}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{c.planning ? "mapping the repos\u2026" : `${done}/${c.slices.length} slices · ${c.outcome ?? (review ? "plan review" : "active")}`}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
        {[...byRepo.entries()].map(([repo, runs]) => (
          <div key={repo} className="mb-4">
            <div className="mb-1 px-1 font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">{repo}</div>
            <Link to="/chat" search={{ repo: runs[0]?.repo ?? repoPathByKey.get(repo) ?? "" }} onClick={onNavigate}
              className="sidebar-item" activeProps={{ className: "sidebar-item active" }}>
              <svg className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 11.5a8.38 8.38 0 01-9 8.36 8.5 8.5 0 01-3.4-.71L3 20l1.35-4.05A8.38 8.38 0 013 11.5a8.5 8.5 0 018.5-8.5 8.38 8.38 0 018.36 9z" strokeLinejoin="round" />
              </svg>
              <span className="flex-1 overflow-hidden">
                <span className="block truncate text-[13px] leading-snug text-foreground/90">Channel</span>
                <span className="font-mono text-[10px] text-muted-foreground">discuss · plans emerge here</span>
              </span>
            </Link>
            {runs.map((r) => {
              const st = runStatus(r);
              return (
                <Link key={r.runId} to="/run/$runId" params={{ runId: r.runId }}
                  onClick={onNavigate}
                  className="sidebar-item"
                  activeProps={{ className: "sidebar-item active" }}>
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[st] ?? "bg-muted-foreground"}`} />
                  <span className="flex-1 overflow-hidden">
                    <span className="block truncate text-[13px] leading-snug">{r.title ?? r.goal.slice(0, 70)}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{r.runId} · {st}</span>
                  </span>
                </Link>
              );
            })}
            <Link to="/new" search={{ repo: runs[0]?.repo ?? repoPathByKey.get(repo) ?? "" }} onClick={onNavigate}
              className="sidebar-item opacity-70 hover:opacity-100">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0" />
              <span className="text-[13px] text-muted-foreground">+ new session</span>
            </Link>
          </div>
        ))}
        {archived.length > 0 && (
          <div className="mb-4">
            <button className="mb-1 flex items-center gap-1 px-1 font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground/70 hover:text-muted-foreground"
              onClick={() => setShowArchive((v) => !v)}>
              <span className={cn("inline-block transition-transform", showArchive && "rotate-90")}>{"\u203A"}</span>
              archive · {archived.length}
            </button>
            {showArchive && archived.map((r) => {
              const st = runStatus(r);
              return (
                <Link key={r.runId} to="/run/$runId" params={{ runId: r.runId }}
                  onClick={onNavigate}
                  className="sidebar-item opacity-60"
                  activeProps={{ className: "sidebar-item active opacity-100" }}>
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[st] ?? "bg-muted-foreground"}`} />
                  <span className="flex-1 overflow-hidden">
                    <span className="block truncate text-[13px] leading-snug">{r.title ?? r.goal.slice(0, 70)}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{r.repo.split("/").pop()} · {st}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
        <Link to="/new" search={{ repo: "" }} onClick={onNavigate}
          className="mt-1 block px-1 font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground/60 hover:text-muted-foreground">
          + add project
        </Link>
        {(data?.runs.length ?? 0) === 0 && (
          <p className="px-1 text-xs text-muted-foreground">No runs yet. Describe an outcome below.</p>
        )}
      </div>
    </aside>
  );
}

export function HomePage() {
  const { data } = useBridge();
  const latest = data?.runs[0];
  if (latest) return <Navigate to="/run/$runId" params={{ runId: latest.runId }} />;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <KrakenMark size={84} color="#1E293B55" />
      <p className="text-sm text-muted-foreground">One head, many arms. Describe an outcome below — the head plans it, you review, the fleet builds it.</p>
    </div>
  );
}

/** The prompt bar: always there, like a chat — no separate task page. */
export function Composer() {
  const { data } = useBridge();
  const nav = useNavigate();
  const qc = useQueryClient();
  const params = useParams({ strict: false }) as { runId?: string };
  const current = data?.runs.find((r) => r.runId === params.runId);
  const [goal, setGoal] = useState("");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const onNew = typeof window !== "undefined" && window.location.pathname === "/new";
  const onChat = typeof window !== "undefined" && window.location.pathname === "/chat";
  const onCampaign = typeof window !== "undefined" && window.location.pathname === "/campaign";
  const chatRepo = onChat ? new URLSearchParams(window.location.search).get("repo") ?? "" : "";
  const searchRepo = onNew ? new URLSearchParams(window.location.search).get("repo") : null;
  const campaign = onCampaign
    ? data?.campaigns?.find((x) => x.id === (new URLSearchParams(window.location.search).get("id") ?? ""))
    : undefined;
  // Ask lands on the first slice that already has a child run — the campaign itself is not a run.
  const campaignRunId = campaign?.slices.find((s) => s.childRunId)?.childRunId;
  const effectiveRepo = repo || (onChat ? chatRepo : onNew ? (searchRepo ?? "") : onCampaign ? (campaign?.slices[0]?.repo ?? "") : current?.repo || data?.runs[0]?.repo || "");
  const pendingPlan = current && data?.decisions.find((d) => d.decisionId === `plan-${current.runId}`);
  const steerPlan = async () => {
    if (!current || !pendingPlan || !goal.trim()) return;
    setBusy(true);
    await decide(current.runId, pendingPlan.decisionId, "replan", goal.trim());
    await startRun(`${current.goal}\n\nReviewer notes on the previous plan (address these):\n- ${goal.trim()}`, current.repo);
    setGoal(""); setBusy(false);
    nav({ to: "/" });
  };
  const send = async () => {
    if (!goal.trim() || !effectiveRepo) return;
    setBusy(true);
    await startRun(goal.trim(), effectiveRepo);
    setGoal("");
    setBusy(false);
    nav({ to: "/" });
  };
  const askCampaign = async () => {
    if (!campaign || !campaignRunId || !goal.trim()) return;
    setAsking(true); setAnswer(null);
    const q = goal.trim(); setGoal("");
    const r = await ask(campaignRunId, [
      `This run is one slice of campaign "${campaign.title}" (${campaign.slices.length} repos chained in dependency order:`,
      `${campaign.slices.map((s) => s.repo.split("/").pop()).join(" → ")}). Answer in that campaign context.`,
      q,
    ].join(" "));
    setAnswer(r.answer); setAsking(false);
  };
  const sendChatMsg = async () => {
    if (!goal.trim() || !chatRepo) return;
    setThinking(true);
    const text = goal.trim();
    setGoal("");
    const pending = sendChat(chatRepo, text);
    // The user message lands in the journal immediately — show it while the arm thinks.
    setTimeout(() => qc.invalidateQueries({ queryKey: ["chat", chatRepo] }), 800);
    await pending;
    qc.invalidateQueries({ queryKey: ["chat", chatRepo] });
    setThinking(false);
  };
  return (
    <div className="composer-dock">
      <div className="w-full">
        {onChat && thinking && (
          <div className="mb-2 rounded-lg border border-border bg-card p-3 text-sm shadow-sm">
            <span className="text-muted-foreground">thinking… the channel reads the repo and journal (read-only arm)</span>
          </div>
        )}
        {(answer || asking) && (
          <div className="mb-2 rounded-lg border border-border bg-card p-3 text-sm shadow-sm">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">fleet answer</span>
              {answer && <button className="text-xs text-muted-foreground" onClick={() => setAnswer(null)}>dismiss</button>}
            </div>
            {asking ? <span className="text-muted-foreground">consulting the run\u2026 (read-only arm)</span>
              : <div className="max-h-56 space-y-2 overflow-y-auto"><Prose text={answer ?? ""} /></div>}
          </div>
        )}
        <div className="rounded-lg border border-border bg-card p-2 shadow-[inset_0_1px_0_rgba(232,240,242,0.03)]">
          <Textarea
            className="min-h-[40px] resize-none border-0 bg-transparent text-sm shadow-none focus-visible:ring-0"
            placeholder={onChat
              ? "Ask about this project, or think out loud\u2026"
              : onCampaign
              ? "Steer this campaign \u2014 note travels to the campaign planner on replan, or ask about its state\u2026"
              : pendingPlan
              ? "Reviewing a plan \u2014 select plan text above to annotate, or type a steering note for the planner\u2026"
              : current ? "Follow up on this run \u2014 the planner gets its full history plus this instruction\u2026"
              : "Describe an outcome \u2014 the head plans, you review, the fleet builds\u2026"}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (onChat ? sendChatMsg : onCampaign ? askCampaign : send)(); }}
          />
          <div className="mt-1 flex items-center gap-2 px-1">
            {!effectiveRepo ? (
              <Input
                className="h-7 flex-1 border-0 bg-transparent font-mono text-[11px] text-muted-foreground shadow-none focus-visible:ring-0"
                placeholder="/path/to/repo"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
              />
            ) : (
              <span className="h-7 min-w-0 flex-1 truncate pt-1 font-mono text-[11px] text-muted-foreground/60">
                in {effectiveRepo.replace(/^\/Users\/[^/]+/, "~")}
              </span>
            )}
            {current && (
              <Button size="sm" variant="outline" disabled={asking || !goal.trim()}
                onClick={async () => {
                  setAsking(true); setAnswer(null);
                  const q = goal.trim(); setGoal("");
                  const r = await ask(current.runId, q);
                  setAnswer(r.answer); setAsking(false);
                }}>
                {asking ? "asking\u2026" : "ask"}
              </Button>
            )}
            {onChat ? (
              <Button size="sm" disabled={thinking || !goal.trim()} onClick={sendChatMsg}>
                {thinking ? "thinking…" : "send"}
              </Button>
            ) : onCampaign ? (
              // Campaign context: ask only — no "plan it"/"follow up" (a campaign is not a run).
              <Button size="sm" disabled={asking || !goal.trim() || !campaignRunId} onClick={askCampaign}
                title={campaignRunId ? undefined : "no slice has a run yet — nothing to ask"}>
                {asking ? "asking…" : "ask"}
              </Button>
            ) : pendingPlan ? (
              <Button size="sm" disabled={busy || !goal.trim()} onClick={steerPlan}>
                {busy ? "replanning\u2026" : "steer replan"}
              </Button>
            ) : current ? (
              <Button size="sm" disabled={busy || !goal.trim()} onClick={async () => {
                setBusy(true);
                await startRun(goal.trim(), current.repo, current.runId);
                setGoal(""); setBusy(false);
                nav({ to: "/" });
              }}>
                {busy ? "planning\u2026" : "follow up"}
              </Button>
            ) : (
              <Button size="sm" disabled={busy || !goal.trim() || !effectiveRepo} onClick={send}>
                {busy ? "planning\u2026" : "plan it"}
              </Button>
            )}
          </div>
        </div>
        <p className="mt-1 px-2 font-mono text-[10px] text-muted-foreground">⌘↩ to send · plans return for review before any arm moves</p>
      </div>
    </div>
  );
}

/* ---------- decision triage: every pending gate across the fleet, one inbox ---------- */

const waitingFor = (at: string): string => {
  const m = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60000));
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

export function DecisionsPage() {
  const { data } = useBridge();
  if (!data) return null;
  if (data.decisions.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 opacity-80">
        <KrakenMark size={72} color="#1E293B55" />
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          Nothing is waiting on you — the fleet is either working or done.
        </p>
      </div>
    );
  }
  const groups = new Map<string, Decision[]>();
  for (const d of data.decisions) {
    const key = d.repoPath?.split("/").pop() || "unknown project";
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return (
    <>
      <SectionTitle>Decisions waiting — {data.decisions.length}</SectionTitle>
      {[...groups.entries()].map(([repo, ds]) => (
        <div key={repo} className="mb-4">
          <div className="mb-1 px-1 font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">{repo}</div>
          <div className="overflow-hidden rounded-lg border border-border">
            {ds.map((d) => (
              <div key={`${d.runId}/${d.decisionId}`} className="flex items-start gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm leading-snug">{md(d.question)}</span>
                  <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
                    {d.contractId ?? "run-level"} · waiting {waitingFor(d.at)}
                  </span>
                </span>
                <Link to="/run/$runId" params={{ runId: d.runId }}
                  className="shrink-0 whitespace-nowrap pt-0.5 font-mono text-[11px] text-sonar hover:underline">
                  open run →
                </Link>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/* ---------- project channel: where intent forms before it becomes a run ---------- */

function CampaignProposalCard({ campaign }: { campaign: NonNullable<ChatMsg["campaign"]> }) {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  return (
    <Card className="mt-2 max-w-[75ch] border-l-2 border-l-sonar p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{campaign.title}</p>
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">campaign · {campaign.repos.length} repos</p>
        </div>
        <Button size="sm" disabled={busy}
          onClick={async () => {
            setBusy(true);
            await startCampaign(campaign.intent, campaign.repos);
            nav({ to: "/" });
          }}>
          {busy ? "planning…" : "start campaign"}
        </Button>
      </div>
      <p className="mt-1 max-w-[70ch] text-xs leading-relaxed text-muted-foreground">{campaign.why}</p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {campaign.repos.map((r) => (
          <span key={r} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{r.split("/").pop()}</span>
        ))}
      </div>
      <Detail label="Full intent for the campaign planner">
        <div className="space-y-1.5 p-1 text-[13px] leading-relaxed"><Prose text={campaign.intent} /></div>
      </Detail>
    </Card>
  );
}

function ProposalCard({ proposal, repo }: { proposal: NonNullable<ChatMsg["proposal"]>; repo: string }) {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  return (
    <Card className="mt-2 max-w-[75ch] p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{proposal.title}</p>
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await startRun(proposal.goal, repo);
            nav({ to: "/" });
          }}
        >
          {busy ? "planning…" : "plan it"}
        </Button>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{proposal.why}</p>
      <Detail label="Full goal for the planner">
        <div className="space-y-1.5 text-[13px] leading-relaxed text-foreground/85"><Prose text={proposal.goal} /></div>
      </Detail>
    </Card>
  );
}

export function ChatPage() {
  const { repo } = newSearch();
  const { data } = useQuery({ queryKey: ["chat", repo], queryFn: () => fetchChat(repo!), enabled: !!repo });
  const msgs = data?.messages ?? [];
  useEffect(() => {
    document.querySelector(".spine-scroll")?.scrollTo({ top: 1e9 });
  }, [msgs.length]);
  if (!repo) return <p className="text-sm text-muted-foreground">No project selected.</p>;
  if (msgs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <KrakenMark size={72} color="#1E293B55" />
        <p className="max-w-sm text-sm text-muted-foreground">
          Ask about this project, or think out loud — when the conversation converges, I'll draft a plan.
        </p>
      </div>
    );
  }
  return (
    <>
      <SectionTitle>{repo.split("/").pop()} · channel</SectionTitle>
      <div className="flex flex-col gap-3 pb-2">
        {msgs.map((m, i) => m.role === "user" ? (
          <div key={i} className="self-end">
            <p className="max-w-[60ch] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm leading-relaxed text-muted-foreground">{m.text}</p>
          </div>
        ) : (
          <div key={i} className="self-start">
            <div className="max-w-[75ch] space-y-2 text-sm leading-relaxed"><Prose text={m.text} /></div>
            {m.proposal && <ProposalCard proposal={m.proposal} repo={repo} />}
            {m.campaign && <CampaignProposalCard campaign={m.campaign} />}
          </div>
        ))}
        {data?.thinking && (
          <div className="flex items-center gap-2 self-start font-mono text-[11px] text-muted-foreground">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sonar" />
            {data.thinking}
          </div>
        )}
      </div>
    </>
  );
}

/* ---------- campaign: one intent, N single-repo runs chained in dependency order ---------- */

const SLICE_PILL: Record<string, Parameters<typeof pill>[0]> = {
  pending: "gray", planning: "cyan", "plan review": "yellow", running: "teal",
  success: "teal", partial: "yellow", declined: "gray", aborted: "red", replanned: "cyan",
};
const SLICE_LIVE = new Set(["planning", "running"]);

/** Slices in dependency waves — the same topological read the reconciler uses. */
function sliceWaves(slices: CampaignSlice[]): { s: CampaignSlice; wave: number }[] {
  const remaining = new Map(slices.map((s) => [s.repo, s]));
  const done = new Set<string>();
  const out: { s: CampaignSlice; wave: number }[] = [];
  let wave = 0;
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((s) => s.dependsOn.every((d) => done.has(d) || !remaining.has(d)));
    if (ready.length === 0) { for (const s of remaining.values()) out.push({ s, wave }); break; }
    for (const s of ready) { remaining.delete(s.repo); done.add(s.repo); out.push({ s, wave }); }
    wave++;
  }
  return out;
}

/** Wave labels name their actual upstreams: the previous wave's repo basenames, capped at 3. */
function upstreamNames(ordered: { s: CampaignSlice; wave: number }[], wave: number): string {
  const names = ordered.filter((x) => x.wave === wave - 1).map((x) => x.s.repo.split("/").pop() ?? x.s.repo);
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} +${names.length - 3}` : shown;
}

function CampaignSliceRow({ s, n, waveLabel }: { s: CampaignSlice; n: number; waveLabel: string | null }) {
  const name = s.repo.split("/").pop() ?? s.repo;
  const live = SLICE_LIVE.has(s.childStatus);
  return (
    <div>
      {waveLabel && (
        <div className="border-b border-border bg-muted/60 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {waveLabel}
        </div>
      )}
      <div className="border-b border-border last:border-b-0">
        <div className="flex w-full items-start gap-3 px-3 py-2.5">
          <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] tabular-nums",
            s.childOutcome === "success" ? "bg-[rgba(5,150,105,0.14)] text-pulse"
              : live ? "bg-[rgba(5,150,105,0.14)] text-pulse animate-pulse"
              : s.childStatus === "plan review" ? "bg-[rgba(180,83,9,0.12)] text-warn"
              : "bg-muted text-muted-foreground")}>{n}</span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate font-mono text-sm font-medium">{name}</span>
              {s.childRunId && (
                <Link to="/run/$runId" params={{ runId: s.childRunId }}
                  className="whitespace-nowrap font-mono text-[11px] text-sonar hover:underline">
                  view run →
                </Link>
              )}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {s.dependsOn.map((d) => (
                <span key={d} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">after {d.split("/").pop()}</span>
              ))}
              {s.dependsOn.length === 0 && <span className="font-mono text-[10px]">no upstream — plans first</span>}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
            <Badge variant="outline" className={pill(SLICE_PILL[s.childStatus] ?? "gray", live || s.childStatus === "plan review")}>
              {s.childStatus}
            </Badge>
          </span>
        </div>
        <div className="px-3 pb-2.5 pl-11">
          <Detail label="Slice goal — what this repo's planner receives">
            <div className="space-y-1.5 text-[13px] leading-relaxed text-foreground/85"><Prose text={s.goal} /></div>
          </Detail>
        </div>
      </div>
    </div>
  );
}

export function CampaignPage() {
  const { data } = useBridge();
  const qc = useQueryClient();
  const [advancing, setAdvancing] = useState(false);
  const id = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("id") ?? "" : "";
  const c: Campaign | undefined = data?.campaigns?.find((x) => x.id === id);
  if (!data) return null;
  if (!c) return <p className="text-sm text-muted-foreground">Campaign not found.</p>;
  const ordered = sliceWaves(c.slices);
  const done = c.slices.filter((s) => s.childOutcome === "success" || s.childOutcome === "partial").length;
  return (
    <>
      <Card className="p-4">
        <p className="font-mono text-xs text-muted-foreground">campaign {c.id}{c.planning ? "" : ` · ${c.slices.length} repos`}</p>
        <h1 className="mt-1 text-[17px] font-semibold leading-snug">{c.title}</h1>
        <Reveal maxHeight={64} showLabel="more" hideLabel="less">
          <div className="mt-1 max-w-[75ch] space-y-2 text-sm leading-relaxed text-muted-foreground"><Prose text={c.intent} /></div>
        </Reveal>
        <div className="mt-3 flex items-center gap-3">
          <Badge variant="outline" className={pill(c.outcome === "success" ? "teal" : c.outcome === "partial" ? "yellow" : c.outcome === "aborted" ? "red" : "cyan", true)}>
            {c.outcome ?? "active"}
          </Badge>
          <span className="font-mono text-[11px] text-muted-foreground">{done}/{c.slices.length} slices done</span>
        </div>
      </Card>
      <SectionTitle>Slices — dependency order</SectionTitle>
      {c.planning && (
        <div className="flex items-center gap-2.5 rounded-lg border border-border bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-sonar" />
          The campaign planner is reading the repositories and drawing the dependency DAG — up to ten minutes for a large campaign.
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-border">
        {ordered.map(({ s, wave }, i) => (
          <CampaignSliceRow key={s.repo} s={s} n={i + 1}
            waveLabel={i === 0 || ordered[i - 1]!.wave !== wave
              ? `Wave ${wave + 1}${wave === 0 ? " — plans immediately" : ` — after ${upstreamNames(ordered, wave)}`}`
              : null} />
        ))}
      </div>
      {!c.outcome && (
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-border bg-background/80 px-3 py-2">
          <Button size="sm" disabled={advancing}
            onClick={async () => {
              setAdvancing(true);
              await advanceCampaign(c.id);
              setTimeout(() => { qc.invalidateQueries({ queryKey: ["state"] }); setAdvancing(false); }, 1200);
            }}>
            {advancing ? "advancing…" : "Advance"}
          </Button>
          <Button size="sm" variant="ghost" className="text-danger" disabled={advancing}
            onClick={async () => {
              if (!window.confirm(`Abort campaign "${c.title}"? Pending slices stop advancing and the campaign is marked aborted.`)) return;
              await abortCampaign(c.id);
              qc.invalidateQueries({ queryKey: ["state"] });
            }}>
            Abort campaign
          </Button>
          <span className="text-xs text-muted-foreground">
            runs plan one at a time — approve each plan as it appears; approval auto-advances the chain
          </span>
        </div>
      )}
    </>
  );
}

export function NewPage() {
  const search = newSearch();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 opacity-80">
      <KrakenMark size={72} color="#1E293B55" />
      <p className="max-w-sm text-center text-sm text-muted-foreground">
        {search.repo
          ? `A fresh session in ${search.repo.split("/").pop()}. Describe the outcome below — the head plans it into tasks, you review before anything runs.`
          : "A new project. Give the repository's absolute path below, describe an outcome, and Kraken takes it from there. Add a kraken.toml to the repo for gates, trunk and skill routing."}
      </p>
    </div>
  );
}

/** Bare entities in plain prose: URLs, PR references, file paths. */
function entities(text: string): ReactNode[] {
  const re = /(https?:\/\/[^\s)]+|\bPR #\d+\b|(?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,6}\b|\b[\w-]+\.(?:tf|hcl|tfvars|ya?ml|toml|lock|sh|md)\b)/g;
  const out: ReactNode[] = [];
  text.split(re).forEach((seg, i) => {
    if (!seg) return;
    if (/^https?:\/\//.test(seg)) {
      out.push(<a key={i} href={seg} target="_blank" rel="noreferrer" className="text-sonar underline decoration-sonar/40 underline-offset-2 hover:decoration-sonar">{seg.replace(/^https?:\/\//, "").slice(0, 60)}</a>);
    } else if (/^PR #\d+$/.test(seg)) {
      out.push(<span key={i} className="whitespace-nowrap rounded bg-[rgba(37,99,235,0.10)] px-1 py-px font-mono text-[0.85em] text-sonar">{seg}</span>);
    } else if (re.source && i % 2 === 1) {
      out.push(<code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.92em]">{seg}</code>);
    } else {
      out.push(seg);
    }
  });
  return out;
}

/** Inline markdown: `code`, **bold**, *italic*. */
function md(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split(/(`[^`]+`)/g).forEach((seg, i) => {
    if (seg.startsWith("`") && seg.endsWith("`") && seg.length > 2) {
      out.push(<code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.92em]">{seg.slice(1, -1)}</code>);
      return;
    }
    seg.split(/(\*\*[^*]+\*\*)/g).forEach((b, j) => {
      if (b.startsWith("**") && b.endsWith("**") && b.length > 4) {
        out.push(<strong key={`${i}b${j}`} className="font-semibold">{b.slice(2, -2)}</strong>);
        return;
      }
      b.split(/(\*[^*\s][^*]*\*)/g).forEach((it, k) => {
        if (it.startsWith("*") && it.endsWith("*") && it.length > 2) out.push(<em key={`${i}i${j}-${k}`}>{it.slice(1, -1)}</em>);
        else if (it) out.push(<span key={`${i}p${j}-${k}`}>{entities(it)}</span>);
      });
    });
  });
  return out;
}

/** Markdown-lite for LLM prose: blank-line paragraphs, "- " bullet blocks, inline md. */
function Prose({ text, wrap }: { text: string; wrap?: (t: string) => ReactNode }) {
  const W = wrap ?? ((t: string) => <>{md(t)}</>);
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split("\n").map((l) => l.trim()).filter(Boolean);
        if (lines.length > 1 && lines.every((l) => /^[-*\u2022] /.test(l))) {
          return (
            <ul key={i} className="list-disc space-y-0.5 pl-4">
              {lines.map((l, j) => <li key={j}>{W(l.replace(/^[-*\u2022] /, ""))}</li>)}
            </ul>
          );
        }
        return <p key={i}>{W(b)}</p>;
      })}
    </>
  );
}

function newSearch(): { repo?: string } {
  if (typeof window === "undefined") return {};
  return { repo: new URLSearchParams(window.location.search).get("repo") ?? undefined };
}
