import type { DocJob, DocRunResult, DocRunner } from "./runner.js";

/**
 * Document worker runs at once (#49, #26): every run of the sandboxed document worker — `doc_create` and the reference
 * export alike — goes through one coordinator, so the server-wide cap really holds (each run may take up to 768MB).
 * At most `total` runs on the server and `perUser` per user; a run over either is refused at once (no queue), and
 * the caller answers its own "busy" (`doc_busy`, `references_busy`).
 */
export const DOC_SLOTS = { total: 2, perUser: 1 } as const;

export class DocSlots {
  private running = 0;
  private readonly byUser = new Map<string, number>();
  /** Most runs seen at once (for tests). */
  peak = 0;

  constructor(
    private readonly runner: DocRunner,
    private readonly limits: { total: number; perUser: number } = DOC_SLOTS,
  ) {}

  /** Runs the job for `userId`, or undefined when no slot is free. */
  async run(userId: string, job: DocJob): Promise<DocRunResult | undefined> {
    const mine = this.byUser.get(userId) ?? 0;
    if (this.running >= this.limits.total || mine >= this.limits.perUser) return undefined;
    this.running++;
    this.byUser.set(userId, mine + 1);
    this.peak = Math.max(this.peak, this.running);
    try {
      return await this.runner(job);
    } finally {
      this.running--;
      const left = (this.byUser.get(userId) ?? 1) - 1;
      if (left > 0) this.byUser.set(userId, left);
      else this.byUser.delete(userId);
    }
  }
}
