import type { Msg } from "../llm/types.ts";

export type SessionMeta = { id: string; startedAt: string; title: string; topics: string[]; seeded: boolean };

export type StoredMessage = { id: string; sessionId: string; at: string; msg: Msg };

/** A fact the agent stated with a citation, valid from validFrom until a later claim contradicts it. */
export type Claim = {
  id: string; sessionId: string; turnId: string;
  subject: string; predicate: string; value: string;
  observedAt: string; validFrom: string; validTo: string | null;
  sourceUrl: string; sourceDate: string | null;
};

export type ClaimInput = Omit<Claim, "id" | "validFrom" | "validTo">;
