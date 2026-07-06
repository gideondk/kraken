import { randomUUID } from "node:crypto";
import type { FindingKind, Journal, TaskContract } from "@kraken/core";
import { globMatch } from "@kraken/skills";

/**
 * The findings bus: agents publish distilled discoveries (decisions, gotchas,
 * interface changes) and Kraken routes each finding to the sibling contracts
 * it is relevant to. Relevance-filtered, never firehose — context rot is real.
 *
 * Routing v1 is deterministic: path overlap with a contract's owned paths, or
 * explicit tag match. Both the publication and the routing decision land in
 * the journal, so "who knew what, when" is answerable after the fact.
 */
export interface Finding {
  findingId: string;
  contractId: string;
  kind: FindingKind;
  summary: string;
  paths: string[];
  tags: string[];
}

export interface PublishInput {
  runId: string;
  contractId: string;
  kind: FindingKind;
  /** Distilled, 1–2k tokens max. Full artifacts go to the store, by reference. */
  summary: string;
  paths?: string[];
  tags?: string[];
}

export class FindingsBus {
  private journal: Journal;

  constructor(journal: Journal) {
    this.journal = journal;
  }

  /** Publish a finding and route it to relevant sibling contracts. */
  publish(input: PublishInput, siblings: TaskContract[]): { finding: Finding; routedTo: string[] } {
    const finding: Finding = {
      findingId: randomUUID().slice(0, 8),
      contractId: input.contractId,
      kind: input.kind,
      summary: input.summary,
      paths: input.paths ?? [],
      tags: input.tags ?? [],
    };
    this.journal.append({
      type: "FindingPublished",
      runId: input.runId,
      contractId: finding.contractId,
      findingId: finding.findingId,
      kind: finding.kind,
      summary: finding.summary,
      paths: finding.paths,
      tags: finding.tags,
    });

    const routedTo = siblings
      .filter((s) => s.id !== input.contractId)
      .filter((s) => this.isRelevant(finding, s))
      .map((s) => s.id);

    if (routedTo.length > 0) {
      this.journal.append({
        type: "FindingRouted",
        runId: input.runId,
        findingId: finding.findingId,
        toContractIds: routedTo,
        reason: this.routeReason(finding),
      });
    }
    return { finding, routedTo };
  }

  /** Findings routed to a contract that it hasn't been shown yet, given a cursor. */
  pendingFor(runId: string, contractId: string, afterSeq: number): { seq: number; finding: Finding }[] {
    const events = this.journal.read({ runId, afterSeq });
    const published = new Map<string, Finding>();
    const routed: { seq: number; findingId: string }[] = [];
    for (const s of events) {
      const e = s.event;
      if (e.type === "FindingPublished")
        published.set(e.findingId, {
          findingId: e.findingId,
          contractId: e.contractId,
          kind: e.kind,
          summary: e.summary,
          paths: e.paths,
          tags: e.tags,
        });
      if (e.type === "FindingRouted" && e.toContractIds.includes(contractId))
        routed.push({ seq: s.seq, findingId: e.findingId });
    }
    return routed
      .map((r) => ({ seq: r.seq, finding: published.get(r.findingId) }))
      .filter((x): x is { seq: number; finding: Finding } => x.finding !== undefined);
  }

  /** Render pending findings as the context block injected at a worker's next turn. */
  renderFor(findings: Finding[]): string {
    if (findings.length === 0) return "";
    const items = findings
      .map((f) => `- [${f.kind}] (from ${f.contractId}) ${f.summary}`)
      .join("\n");
    return `# Findings from sibling agents (published while you worked — adjust if they affect your task)\n${items}`;
  }

  private isRelevant(finding: Finding, sibling: TaskContract): boolean {
    // Blockers go to everyone: they usually mean "stop digging where I dug".
    if (finding.kind === "blocker") return true;
    const pathOverlap = finding.paths.some((p) =>
      sibling.boundaries.ownsPaths.some(
        (owned) => globMatch(owned, p) || globMatch(p, owned) || p === owned,
      ),
    );
    if (pathOverlap) return true;
    return finding.tags.some((t) =>
      sibling.objective.toLowerCase().includes(t.toLowerCase()),
    );
  }

  private routeReason(finding: Finding): string {
    if (finding.kind === "blocker") return "blocker: broadcast";
    if (finding.paths.length > 0) return `path overlap: ${finding.paths.join(", ")}`;
    return `tag match: ${finding.tags.join(", ")}`;
  }
}
