import type { ModelDefault, RunChoice, RuntimeDefaults, RuntimeId } from "@agentlee/shared";
import type { UserStore } from "../auth/users.js";
import type { ModelCapability, RuntimeCapabilities } from "../runtime/adapter.js";
import type { ConnectionRow, ConnectionStore, EffectivePolicy } from "./store.js";

/** A run choice the user may not make: the request is refused with 403 and this code (nothing is created). */
export class RunAccessDenied extends Error {
  constructor(
    readonly code:
      | "runtime_not_allowed"
      | "model_not_allowed"
      | "effort_not_allowed"
      | "connection_not_allowed"
      /** The connection is at its usage limit (#19): not for a new conversation or a switch to it. */
      | "connection_limited",
  ) {
    super(code);
  }
}

export type RunSettingsInput = {
  userId: string;
  runtime: RuntimeId;
  capabilities: RuntimeCapabilities;
  /** What the request asked for explicitly — refused (403) when not allowed. */
  requested: RunChoice;
  /** What the conversation would use otherwise (the regenerated reply's model and effort) — replaced when not allowed. */
  current: { model: string | null; effort: string | null };
};

export type RunSettings = {
  model: ModelCapability;
  effort: string | null;
  /** The connection to use; null when the runtime needs none, or when there is none (the run fails `no_connection`). */
  connectionId: string | null;
  /** The chosen connection's credential version: the run uses exactly this credential. */
  connectionVersion: number | null;
  useShared: boolean;
};

const allows = (list: "all" | string[], v: string) => list === "all" || list.includes(v);

/**
 * The one check of runtime, model, effort and connection (PRD FR-1.6, FR-11, acceptance 9–10), used by message
 * send, edit and regenerate through the run manager (and by schedules, #55). Explicit choices that are not allowed
 * are refused; implicit ones fall back to the first allowed value (the full fallback order is #19).
 */
export class RunAccess {
  constructor(
    private readonly users: Pick<UserStore, "byId">,
    private readonly connections: ConnectionStore,
  ) {}

  /**
   * Models of `capabilities` the policy allows, each with only the allowed effort values. A model that takes an
   * effort setting but has none left after the policy is *not* runnable — leaving the effort out would let the
   * runtime fall back to its own default (review #84) — so it is dropped. Models without any effort setting stay.
   */
  models(policy: EffectivePolicy, capabilities: RuntimeCapabilities): ModelCapability[] {
    if (!policy.allowed) return [];
    return capabilities.models.flatMap((m) => {
      if (!allows(policy.models, m.id)) return [];
      const efforts = m.efforts.filter((e) => allows(policy.efforts, e));
      if (m.efforts.length > 0 && efforts.length === 0) return [];
      const { defaultEffort, ...rest } = m;
      return [
        defaultEffort && efforts.includes(defaultEffort)
          ? { ...rest, efforts, defaultEffort }
          : { ...rest, efforts },
      ];
    });
  }

  /**
   * Whether `defaults` may be saved for this user (FR-12.1, #35): the default runtime and every runtime's default
   * model and effort go through `resolve` exactly as an explicit choice of a run would — the same allowed list the
   * chip (#19) and the run check use. Throws `RunAccessDenied` with the first refusal. `caps` = the runtime's
   * capabilities on this server (undefined: not registered → `runtime_not_allowed`).
   */
  checkDefaults(
    userId: string,
    defaults: RuntimeDefaults,
    caps: (runtime: RuntimeId) => RuntimeCapabilities | undefined,
  ): void {
    const code = this.defaultsProblem(userId, defaults.runtime, defaults.models[defaults.runtime], caps);
    if (code) throw new RunAccessDenied(code);
    for (const runtime of Object.keys(defaults.models) as RuntimeId[]) {
      const c = this.defaultsProblem(userId, runtime, defaults.models[runtime], caps);
      if (c) throw new RunAccessDenied(c);
    }
  }

  /** Runtimes of `defaults` whose saved choice is not allowed (any more) — the settings notice (FR-12.6). */
  unavailableDefaults(
    userId: string,
    defaults: RuntimeDefaults,
    caps: (runtime: RuntimeId) => RuntimeCapabilities | undefined,
  ): RuntimeId[] {
    const runtimes = new Set<RuntimeId>([defaults.runtime, ...(Object.keys(defaults.models) as RuntimeId[])]);
    return [...runtimes].filter((r) => this.defaultsProblem(userId, r, defaults.models[r], caps) !== null);
  }

  private defaultsProblem(
    userId: string,
    runtime: RuntimeId,
    model: ModelDefault | undefined,
    caps: (runtime: RuntimeId) => RuntimeCapabilities | undefined,
  ): RunAccessDenied["code"] | null {
    const capabilities = caps(runtime);
    if (!capabilities) return "runtime_not_allowed";
    try {
      this.resolve({
        userId,
        runtime,
        // Only the model and effort are checked: whether a connection exists is the run's business.
        capabilities: { ...capabilities, needsConnection: false },
        requested: model ? { model: model.model, ...(model.effort ? { effort: model.effort } : {}) } : {},
        current: { model: null, effort: null },
      });
      return null;
    } catch (e) {
      if (e instanceof RunAccessDenied) return e.code;
      throw e;
    }
  }

  /** Whether the connection is at its usage limit right now (#19, FR-12.6). */
  connectionLimited(id: string): boolean {
    const c = this.connections.get(id);
    return !!c && this.connections.limited(c);
  }

  resolve(input: RunSettingsInput): RunSettings {
    const user = this.users.byId(input.userId);
    if (!user?.active) throw new RunAccessDenied("runtime_not_allowed");
    const policy = this.connections.policy(user, input.runtime);
    if (!policy.allowed) throw new RunAccessDenied("runtime_not_allowed");
    const models = this.models(policy, input.capabilities);
    const req = input.requested;

    let model: ModelCapability | undefined;
    if (req.model !== undefined) {
      model = models.find((m) => m.id === req.model);
      // An allowed model whose every effort value is forbidden: refused for its effort.
      if (
        !model &&
        allows(policy.models, req.model) &&
        input.capabilities.models.some((m) => m.id === req.model)
      )
        throw new RunAccessDenied("effort_not_allowed");
    } else model = models.find((m) => m.id === input.current.model) ?? models[0];
    if (!model) throw new RunAccessDenied("model_not_allowed");

    let effort: string | null;
    if (req.effort !== undefined) {
      if (!model.efforts.includes(req.effort)) throw new RunAccessDenied("effort_not_allowed");
      effort = req.effort;
    } else if (
      input.current.effort &&
      model.id === input.current.model &&
      model.efforts.includes(input.current.effort)
    )
      effort = input.current.effort;
    else effort = model.defaultEffort ?? model.efforts[0] ?? null;
    // Never "no effort" for a model that takes one (the runtime would pick its own default).
    if (effort === null && input.capabilities.models.find((m) => m.id === model.id)?.efforts.length)
      throw new RunAccessDenied("effort_not_allowed");

    const useShared = req.useShared === true;
    if (!input.capabilities.needsConnection) {
      if (req.connectionId !== undefined) throw new RunAccessDenied("connection_not_allowed");
      return { model, effort, connectionId: null, connectionVersion: null, useShared };
    }

    let chosen: ConnectionRow | undefined;
    if (req.connectionId !== undefined) {
      const c = this.connections.get(req.connectionId);
      // Someone else's personal connection, a disconnected or untested one, another runtime's: all the same 403.
      if (!c || !this.connections.usable(c, user, input.runtime) || (useShared && c.scope !== "shared"))
        throw new RunAccessDenied("connection_not_allowed");
      chosen = c;
    } else {
      if (useShared && !policy.allowShared) throw new RunAccessDenied("connection_not_allowed");
      const usable = this.connections.usableFor(user, input.runtime);
      // Personal first (FR-11.3) unless the user asked for the shared one.
      chosen = useShared ? usable.find((c) => c.scope === "shared") : usable[0];
    }
    return {
      model,
      effort,
      connectionId: chosen?.id ?? null,
      connectionVersion: chosen?.credentialVersion ?? null,
      useShared,
    };
  }
}
