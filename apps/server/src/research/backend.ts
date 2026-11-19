import type { ResearchBackendId, ResearchPlan } from "@agentlee/shared";

/**
 * Who does the research of a 깊이 조사 job (#211 decision 6). The plan, the writer and the server's verification are
 * always ours (the lead on Claude, `cite` / `file_cite`); a backend only *collects findings* for the approved plan.
 *
 * - `claude` (stage 1, built in): the engine itself runs the sub-researchers on the owner's Claude connection
 *   (engine.ts `research`) — no `collect` here.
 * - External Deep Research APIs (stage 2, TODO(#211 2단계)): Gemini Deep Research, OpenAI deep research. An admin sets
 *   the key and whether it is allowed (encrypted like a shared connection); the plan card offers it with the notice
 *   that the question (and, when chosen, the attachments) go to that company; youth accounts get it only when the admin
 *   allows it (off by default). Its findings are claims with the URL and passage they rest on: the engine fetches
 *   each URL into the conversation's sources and keeps only the findings whose passage the server finds there — the
 *   same check as the built-in notes — so the writer and the report's verification are the same for every backend.
 */
export type ExternalFinding = { claim: string; url: string; quote: string };

export interface ResearchBackend {
  readonly id: ResearchBackendId;
  /** Shown on the plan card. */
  readonly label: string;
  /** Sends the question (and maybe attachments) to a third party — the card must say so. */
  readonly external: boolean;
  /** Whether this user may choose it now (admin switch, key, youth default). */
  available(user: { youth: boolean }): boolean;
  /**
   * External backends only: run the provider's research for the plan and return its findings. Must stop (reject)
   * once `signal` aborts — the job's deadline or the owner's stop.
   */
  collect?(input: {
    question: string;
    plan: ResearchPlan;
    signal: AbortSignal;
    deadlineAt: number;
  }): Promise<ExternalFinding[]>;
}

/** The built-in backend: the engine's own sub-researchers on Claude (Agent SDK). Available to everyone, youth too. */
export const CLAUDE_BACKEND: ResearchBackend = {
  id: "claude",
  label: "기본 (Claude)",
  external: false,
  available: () => true,
};

export class ResearchBackends {
  private readonly byId = new Map<ResearchBackendId, ResearchBackend>([["claude", CLAUDE_BACKEND]]);

  register(b: ResearchBackend): void {
    this.byId.set(b.id, b);
  }

  get(id: ResearchBackendId): ResearchBackend | undefined {
    return this.byId.get(id);
  }
}
