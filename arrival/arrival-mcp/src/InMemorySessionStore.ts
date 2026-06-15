import type { ArrivalSessionStore, ErrorType, InteractionRecord, SessionRecord } from "./store.js";

export class InMemorySessionStore implements ArrivalSessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly interactions: InteractionRecord[] = [];

  async startSession(session: Omit<SessionRecord, "interactionCount" | "phantomCount">): Promise<void> {
    this.sessions.set(session.id, { ...session, interactionCount: 0, phantomCount: 0 });
  }

  async endSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) session.endedAt = Date.now();
  }

  async recordInteraction(interaction: InteractionRecord): Promise<void> {
    this.interactions.push(interaction);

    const session = this.sessions.get(interaction.sessionId);
    if (session) {
      session.interactionCount++;
      if (!interaction.success) session.phantomCount++;
    }
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async getInteractions(sessionId: string): Promise<InteractionRecord[]> {
    return this.interactions.filter((i) => i.sessionId === sessionId);
  }

  async getPhantoms(query?: { tool?: string; errorType?: ErrorType; limit?: number }): Promise<InteractionRecord[]> {
    let results = this.interactions.filter((i) => !i.success);
    if (query?.tool) results = results.filter((i) => i.tool === query.tool);
    if (query?.errorType) results = results.filter((i) => i.errorType === query.errorType);
    if (query?.limit) results = results.slice(0, query.limit);
    return results;
  }
}
