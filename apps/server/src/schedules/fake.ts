import type { ExecuteOutcome, RunOutcome, ScheduleHandler, ScheduleRunContext } from "./engine.js";

export type FakeStep = "execute" | "save" | "notify";

/**
 * Where a fake handler keeps what it "stored" and "published" — pass the same one to the handler of the next
 * process in a crash test, as a real handler's rows outlive the process.
 */
export type FakeOutbox = {
  /** runId → the saved result (one entry per run: `saveResult` is idempotent). */
  results: Map<string, RunOutcome & { at: number }>;
  /** runId → the published notification (one per run: `notify` is idempotent). */
  notifications: Map<string, { status: RunOutcome["status"]; at: number }>;
  /** runId → how many times a result was really written / a notification really published (each must be 1). */
  saveWrites: Map<string, number>;
  publishes: Map<string, number>;
};
export const fakeOutbox = (): FakeOutbox => ({
  results: new Map(),
  notifications: new Map(),
  saveWrites: new Map(),
  publishes: new Map(),
});
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

export type FakeScheduleHandlerOptions = {
  now?: () => number;
  outbox?: FakeOutbox;
  /** What `execute` answers (default: success). */
  script?: (ctx: ScheduleRunContext) => ExecuteOutcome | Promise<ExecuteOutcome>;
  /**
   * Steps that never return — the process "dies" there. `save` / `notify`: before storing; `saved` / `notified`:
   * after storing, before returning (the idempotency case).
   */
  hang?: Partial<Record<FakeStep | "saved" | "notified", boolean>>;
};

const never = () => new Promise<never>(() => {});

/**
 * The test / development handler (#33): no runtime, no conversation, no push — it records each step. `FAKE_RUNTIME=1`
 * servers use it until the real handler (#56) exists. Idempotent per run id, as the contract asks.
 */
export class FakeScheduleHandler implements ScheduleHandler {
  /** Every call, in order (`at` = the clock when it was called). */
  readonly calls: { step: FakeStep; runId: string; attempt: number; at: number }[] = [];
  readonly outbox: FakeOutbox;
  private readonly now: () => number;

  constructor(private readonly opts: FakeScheduleHandlerOptions = {}) {
    this.outbox = opts.outbox ?? fakeOutbox();
    this.now = opts.now ?? Date.now;
  }

  private record(step: FakeStep, ctx: ScheduleRunContext): void {
    this.calls.push({ step, runId: ctx.runId, attempt: ctx.attempt, at: this.now() });
  }

  async execute(ctx: ScheduleRunContext): Promise<ExecuteOutcome> {
    this.record("execute", ctx);
    if (this.opts.hang?.execute) return never();
    return (await this.opts.script?.(ctx)) ?? { ok: true, outputRef: `fake:${ctx.runId}` };
  }

  async saveResult(ctx: ScheduleRunContext, outcome: RunOutcome): Promise<{ resultRef: string | null }> {
    this.record("save", ctx);
    if (this.opts.hang?.save) return never();
    if (!this.outbox.results.has(ctx.runId)) {
      this.outbox.results.set(ctx.runId, { ...outcome, at: this.now() });
      bump(this.outbox.saveWrites, ctx.runId);
    }
    if (this.opts.hang?.saved) return never();
    return { resultRef: `result:${ctx.runId}` };
  }

  async notify(ctx: ScheduleRunContext, outcome: RunOutcome): Promise<void> {
    this.record("notify", ctx);
    if (this.opts.hang?.notify) return never();
    if (!this.outbox.notifications.has(ctx.runId)) {
      this.outbox.notifications.set(ctx.runId, { status: outcome.status, at: this.now() });
      bump(this.outbox.publishes, ctx.runId);
    }
    if (this.opts.hang?.notified) return never();
  }
}
