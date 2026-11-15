import { describe, expect, it } from "vitest";
import type { RuntimeAdapter, RuntimeEvent, StartContext } from "../../src/runtime/adapter.js";

/**
 * Contract every runtime adapter must pass (#12). FakeRuntime runs it here; the real adapters (#15 Claude Agent
 * SDK, #16 codex app-server) run the same suite against their runtimes. `prompts` are the inputs that make the
 * runtime answer in the way each test needs.
 */
export type ContractOptions = {
  /** A prompt that yields a short text answer. */
  short: string;
  /** A prompt that keeps the runtime busy long enough to interrupt it. */
  long: string;
  /** A prompt that answers with something that proves it remembered `remember`. */
  remember: string;
  recall: string;
  recallCheck: (answer: string) => boolean;
  timeoutMs?: number;
};

const ctx = (model: string): StartContext => ({
  conversationId: "contract",
  userId: "contract",
  history: [],
  systemPrompt: "",
  model,
  tools: [],
});

async function collect(events: AsyncIterable<RuntimeEvent>, stopAfter?: number, onCount?: () => void) {
  const out: RuntimeEvent[] = [];
  for await (const e of events) {
    out.push(e);
    if (stopAfter !== undefined && out.filter((x) => x.type === "text_delta").length === stopAfter)
      onCount?.();
  }
  return out;
}

const text = (events: RuntimeEvent[]) =>
  events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");

export function runtimeContract(
  name: string,
  make: () => RuntimeAdapter | Promise<RuntimeAdapter>,
  o: ContractOptions,
) {
  const timeout = o.timeoutMs ?? 10_000;
  describe(`runtime contract: ${name}`, () => {
    it(
      "declares models with their effort levels",
      async () => {
        const caps = (await make()).capabilities();
        expect(caps.models.length).toBeGreaterThan(0);
        for (const m of caps.models) {
          expect(m.id).toBeTruthy();
          if (m.defaultEffort) expect(m.efforts).toContain(m.defaultEffort);
        }
      },
      timeout,
    );

    it(
      "streams a turn as text deltas and finishes",
      async () => {
        const a = await make();
        const s = await a.start(ctx(a.capabilities().models[0]!.id));
        expect(s.externalSessionId).toBeTruthy();
        const events = await collect(s.turn({ text: o.short, model: a.capabilities().models[0]!.id }).events);
        expect(events.filter((e) => e.type === "text_delta").length).toBeGreaterThan(1);
        expect(text(events).length).toBeGreaterThan(0);
        await s.close();
      },
      timeout,
    );

    it(
      "resumes a session by id and remembers it",
      async () => {
        const a = await make();
        if (!a.capabilities().canResume) return; // the run manager then always starts fresh sessions
        const model = a.capabilities().models[0]!.id;
        const s1 = await a.start(ctx(model));
        await collect(s1.turn({ text: o.remember, model }).events);
        await s1.close();
        const s2 = await a.resume(s1.externalSessionId, ctx(model));
        expect(s2.externalSessionId).toBe(s1.externalSessionId);
        expect(o.recallCheck(text(await collect(s2.turn({ text: o.recall, model }).events)))).toBe(true);
        await s2.close();
      },
      timeout,
    );

    it(
      "stops promptly on interrupt",
      async () => {
        const a = await make();
        const model = a.capabilities().models[0]!.id;
        const s = await a.start(ctx(model));
        const turn = s.turn({ text: o.long, model });
        const t0 = Date.now();
        let interruptedAt = 0;
        await collect(turn.events, 3, () => {
          interruptedAt = Date.now();
          void turn.interrupt();
        }).catch(() => []); // some runtimes end an interrupted turn with an error; the run manager decides
        expect(interruptedAt).toBeGreaterThan(0);
        expect(Date.now() - interruptedAt).toBeLessThan(3000);
        expect(Date.now() - t0).toBeLessThan(timeout);
        await s.close();
      },
      timeout,
    );

    it(
      "changes the model inside a session when it says it can",
      async () => {
        const a = await make();
        const caps = a.capabilities();
        if (!caps.canSwitchModelInSession || caps.models.length < 2) return;
        const s = await a.start(ctx(caps.models[0]!.id));
        await s.setModel(caps.models[1]!.id);
        const events = await collect(s.turn({ text: o.short, model: caps.models[1]!.id }).events);
        expect(text(events).length).toBeGreaterThan(0);
        await s.close();
      },
      timeout,
    );
  });
}
