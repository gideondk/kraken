import { DatabaseSync } from "node:sqlite";
import type { KrakenEvent, StoredEvent } from "./events.ts";

/**
 * Append-only event journal on SQLite (node:sqlite — no native deps).
 * One journal per kraken home; runs are partitioned by runId inside events.
 */
export class Journal {
  private db: DatabaseSync;
  private listeners: Set<(e: StoredEvent) => void> = new Set();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // Multiple processes share this journal (bridge, detached runs, MCP).
    // WAL lets readers and one writer coexist; busy_timeout waits out contention
    // instead of throwing SQLITE_BUSY into an unhandled crash.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq   INTEGER PRIMARY KEY AUTOINCREMENT,
        at    TEXT NOT NULL,
        run   TEXT NOT NULL,
        type  TEXT NOT NULL,
        body  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run, seq);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, seq);
    `);
  }

  append(event: KrakenEvent): StoredEvent {
    const at = new Date().toISOString();
    const stmt = this.db.prepare(
      "INSERT INTO events (at, run, type, body) VALUES (?, ?, ?, ?)",
    );
    const res = stmt.run(at, event.runId, event.type, JSON.stringify(event));
    const stored: StoredEvent = { seq: Number(res.lastInsertRowid), at, event };
    for (const l of this.listeners) l(stored);
    return stored;
  }

  /** Replay events, optionally scoped to a run and/or after a sequence number. */
  read(opts: { runId?: string; afterSeq?: number } = {}): StoredEvent[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts.runId) {
      clauses.push("run = ?");
      params.push(opts.runId);
    }
    if (opts.afterSeq !== undefined) {
      clauses.push("seq > ?");
      params.push(opts.afterSeq);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT seq, at, body FROM events ${where} ORDER BY seq`)
      .all(...params) as { seq: number; at: string; body: string }[];
    return rows.map((r) => ({ seq: r.seq, at: r.at, event: JSON.parse(r.body) as KrakenEvent }));
  }

  /** Fold a projection over events. Projections are how the bridge and CLI see state. */
  project<S>(initial: S, fold: (state: S, e: StoredEvent) => S, opts: { runId?: string } = {}): S {
    return this.read(opts).reduce(fold, initial);
  }

  /** Live tail for SSE / MCP notifications. Returns an unsubscribe function. */
  subscribe(listener: (e: StoredEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.db.close();
  }
}
