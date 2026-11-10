// JSONL memory on disk with in-memory indexes rebuilt at startup.
//   data/sessions/<id>.jsonl  meta line, then one message per line (lossless transcript)
//   data/claims.jsonl         append-only; a closed claim is re-appended, last record per id wins

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dayKey } from "../clock.ts";
import type { Msg } from "../llm/types.ts";
import type { Claim, ClaimInput, SessionMeta, StoredMessage, TurnMeta } from "./types.ts";

type SessionRecord = { meta: SessionMeta; messages: StoredMessage[] };

const norm = (s: string) => s.toLowerCase().trim();

export class MemoryStore {
  private sessions = new Map<string, SessionRecord>();
  private claimList: Claim[] = [];
  private queues = new Map<string, Promise<void>>();

  private constructor(private readonly dir: string) {}

  static async open(dir: string): Promise<MemoryStore> {
    const store = new MemoryStore(dir);
    await mkdir(join(dir, "sessions"), { recursive: true });
    await store.load();
    return store;
  }

  private sessionPath(id: string) { return join(this.dir, "sessions", `${id}.jsonl`); }
  private get claimsPath() { return join(this.dir, "claims.jsonl"); }

  private async load(): Promise<void> {
    for (const file of await readdir(join(this.dir, "sessions"))) {
      if (!file.endsWith(".jsonl")) continue;
      let meta: SessionMeta | null = null;
      const messages: StoredMessage[] = [];
      for (const rec of parseLines(await readFile(join(this.dir, "sessions", file), "utf8"))) {
        if (rec.type === "meta") { const { type: _t, ...m } = rec; meta = m as SessionMeta; }
        else if (rec.type === "message" && !messages.some((x) => x.id === rec.id)) { const { type: _t, ...m } = rec; messages.push(m as StoredMessage); }
      }
      if (meta) this.sessions.set(meta.id, { meta, messages });
    }
    const byId = new Map<string, Claim>();
    try {
      for (const rec of parseLines(await readFile(this.claimsPath, "utf8"))) byId.set(rec.id, rec as Claim);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.claimList = [...byId.values()];
  }

  /** Serialise writes per file so a rewrite never interleaves with an append. */
  private enqueue(path: string, op: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(path) ?? Promise.resolve()).then(op);
    this.queues.set(path, next.catch(() => {}));
    return next;
  }

  listSessions(): SessionMeta[] {
    return [...this.sessions.values()].map((r) => r.meta).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  getSession(id: string): SessionMeta | undefined { return this.sessions.get(id)?.meta; }

  async createSession(init: { id?: string; startedAt: string; seeded?: boolean }): Promise<SessionMeta> {
    const meta: SessionMeta = { id: init.id ?? randomUUID(), startedAt: init.startedAt, title: "", topics: [], seeded: init.seeded ?? false };
    if (this.sessions.has(meta.id)) throw new Error(`Session ${meta.id} already exists`);
    this.sessions.set(meta.id, { meta, messages: [] });
    await this.enqueue(this.sessionPath(meta.id), () => writeFile(this.sessionPath(meta.id), line({ type: "meta", ...meta })));
    return meta;
  }

  async updateSession(id: string, patch: Partial<Pick<SessionMeta, "title" | "topics">>): Promise<void> {
    const rec = this.mustGet(id);
    rec.meta = { ...rec.meta, ...patch };
    const path = this.sessionPath(id);
    // Snapshot now: messages appended after this call are written by their own queued appends.
    const body = line({ type: "meta", ...rec.meta }) + rec.messages.map((m) => line({ type: "message", ...m })).join("");
    await this.enqueue(path, async () => {
      await writeFile(`${path}.tmp`, body);
      await rename(`${path}.tmp`, path);
    });
  }

  async appendMessage(sessionId: string, msg: Msg, at: string, meta?: TurnMeta): Promise<StoredMessage> {
    const rec = this.mustGet(sessionId);
    const stored: StoredMessage = { id: randomUUID(), sessionId, at, msg, ...(meta ? { meta } : {}) };
    rec.messages.push(stored);
    await this.enqueue(this.sessionPath(sessionId), () => appendFile(this.sessionPath(sessionId), line({ type: "message", ...stored })));
    return stored;
  }

  getMessages(sessionId: string): StoredMessage[] { return [...(this.sessions.get(sessionId)?.messages ?? [])]; }

  /** Messages whose timestamp falls on `day` (local YYYY-MM-DD), across all sessions, oldest first. */
  messagesOnDay(day: string): StoredMessage[] {
    const out: StoredMessage[] = [];
    for (const r of this.sessions.values()) for (const m of r.messages) if (dayKey(m.at) === day) out.push(m);
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Adds a claim; any open claim with the same subject+predicate and a different value is closed at input.observedAt. */
  async addClaim(input: ClaimInput): Promise<Claim> {
    const closed: Claim[] = [];
    this.claimList = this.claimList.map((c) => {
      const contradicts = c.validTo === null && norm(c.subject) === norm(input.subject)
        && norm(c.predicate) === norm(input.predicate) && c.value !== input.value;
      if (!contradicts) return c;
      const updated = { ...c, validTo: input.observedAt };
      closed.push(updated);
      return updated;
    });
    const claim: Claim = { ...input, id: randomUUID(), validFrom: input.observedAt, validTo: null };
    this.claimList.push(claim);
    await this.enqueue(this.claimsPath, () => appendFile(this.claimsPath, [...closed, claim].map(line).join("")));
    return claim;
  }

  claims(): Claim[] { return [...this.claimList]; }

  private mustGet(id: string): SessionRecord {
    const rec = this.sessions.get(id);
    if (!rec) throw new Error(`Unknown session ${id}`);
    return rec;
  }
}

function line(obj: unknown): string { return JSON.stringify(obj) + "\n"; }

function parseLines(text: string): any[] {
  const out: any[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* a torn last line from a crash is skipped, not fatal */ }
  }
  return out;
}
