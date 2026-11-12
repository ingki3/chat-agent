import {
  SERVICE_DEFAULTS,
  type ChangeSettingsRequest,
  type ChatSettings,
  type DefaultsResponse,
  type ModelDefault,
  type RunChoice,
  type RuntimeDefaults,
  type RuntimeId,
} from "@agentlee/shared";
import { storedDefaults, type UserRow } from "../auth/users.js";
import { RunAccessDenied, type RunAccess } from "../connections/access.js";
import type { RuntimeCapabilities, RuntimeRegistry } from "../runtime/adapter.js";

/** The fixed runtime order of the FR-12.6 fallback ("다른 런타임(Claude Code → Codex 순)"). */
export const RUNTIME_ORDER: readonly RuntimeId[] = ["claude-code", "codex"];

/**
 * Where a new conversation starts (#19): the settings, whether the default itself could not be used, and — when that
 * was a usage limit — until when.
 */
export type StartSettings = { settings: ChatSettings; fallback: boolean; limitedUntil?: number };

/** The candidate's connection is at a usage limit covering its model (403 `connection_limited` for the chip). */
class LimitedError extends RunAccessDenied {
  constructor(readonly until: number) {
    super("connection_limited");
  }
}

/**
 * Default runtime, model and effort (PRD D3, FR-12.1·12.3·12.4, #35). The user's own choice wins, then the admin's
 * initial value for that user, then the service default (Claude Code · Opus 5.5). Saving either one goes through
 * `RunAccess.checkDefaults` — the same allowed list as the run check and the picker — so a model the admin did not
 * allow can never be saved (403 for the user, 400 for the admin).
 *
 * #19 adds what new conversations start with (`start`, the FR-12.6 fallback order) and the chip's per-conversation
 * change (`change`). Both go through `RunAccess.resolve` — the run check itself — with the runtime's real
 * capabilities, so "usable" also means a `passed` connection the user may use.
 */
export class DefaultsService {
  constructor(
    private readonly access: RunAccess,
    private readonly registry: RuntimeRegistry,
  ) {}

  private caps = (runtime: RuntimeId): RuntimeCapabilities | undefined =>
    this.registry.get(runtime)?.capabilities();

  private resolved(user: UserRow): { defaults: RuntimeDefaults; source: DefaultsResponse["source"] } {
    const own = storedDefaults(user.defaults);
    const initial = storedDefaults(user.initialDefaults);
    return own
      ? { defaults: own, source: "own" }
      : initial
        ? { defaults: initial, source: "initial" }
        : { defaults: SERVICE_DEFAULTS, source: "service" };
  }

  effective(user: UserRow): DefaultsResponse {
    const { defaults, source } = this.resolved(user);
    // Only a saved value can have become unusable; the service default is whatever the server offers.
    const unavailable =
      source === "service" ? [] : this.access.unavailableDefaults(user.id, defaults, this.caps);
    const start = this.start(user);
    return {
      defaults,
      source,
      unavailable,
      start: start?.settings ?? null,
      fallback: start?.fallback ?? false,
      limitedUntil: start?.limitedUntil ?? null,
    };
  }

  /** Throws `RunAccessDenied` when `defaults` is not allowed for `userId`. */
  check(userId: string, defaults: RuntimeDefaults): void {
    this.access.checkDefaults(userId, defaults, this.caps);
  }

  /**
   * One candidate: `runtime` with the explicit `requested` model / effort (null when not allowed) and `current` as
   * the implicit preference. Usable = the run check passes, there is a connection to run it with, and that connection
   * is not at a usage limit covering the model. `seen.limitedUntil` notes a limit that stopped it (for the notice).
   */
  private attempt(
    userId: string,
    runtime: RuntimeId,
    requested: RunChoice,
    current: { model: string | null; effort: string | null },
    seen?: { limitedUntil?: number },
  ): ChatSettings | null {
    try {
      return this.settle(userId, runtime, requested, current, { limit: true });
    } catch (e) {
      if (e instanceof LimitedError && seen) seen.limitedUntil = e.until;
      if (e instanceof RunAccessDenied) return null;
      throw e;
    }
  }

  /**
   * As `attempt`, but throws the refusal (403 for the chip). `limit`: a connection at a usage limit covering the model
   * does not count (FR-12.6 "한도 도달") — for new conversations, and for the chip when it moves a conversation onto it.
   */
  private settle(
    userId: string,
    runtime: RuntimeId,
    requested: RunChoice,
    current: { model: string | null; effort: string | null },
    opts: { limit: boolean },
  ): ChatSettings {
    const capabilities = this.caps(runtime);
    if (!capabilities) throw new RunAccessDenied("runtime_not_allowed");
    const s = this.access.resolve({ userId, runtime, capabilities, requested, current });
    // Allowed but nothing to run it with (no passed connection, or no shared one for "공용으로 쓰기").
    if (capabilities.needsConnection && !s.connectionId) throw new RunAccessDenied("connection_not_allowed");
    const until =
      opts.limit && s.connectionId ? this.access.connectionLimitedUntil(s.connectionId, s.model.id) : null;
    if (until !== null) throw new LimitedError(until);
    return { runtime, model: s.model.id, effort: s.effort, useShared: s.useShared };
  }

  /** The saved model of `runtime` as a preference: its effort is kept when still allowed, else the model's own. */
  private withDefault(
    userId: string,
    runtime: RuntimeId,
    d: ModelDefault,
    seen?: { limitedUntil?: number },
  ): ChatSettings | null {
    return this.attempt(userId, runtime, { model: d.model }, { model: d.model, effort: d.effort }, seen);
  }

  /**
   * The first usable model of `runtime` in the model-list order (the adapter's catalogue — the admin's model list,
   * 20.3), skipping ones not allowed or at a limit; the saved model keeps its saved effort.
   */
  private firstUsable(
    userId: string,
    runtime: RuntimeId,
    saved: ModelDefault | undefined,
  ): ChatSettings | null {
    for (const m of this.caps(runtime)?.models ?? []) {
      const effort = saved?.model === m.id ? saved.effort : null;
      const s = this.attempt(userId, runtime, { model: m.id }, { model: m.id, effort });
      if (s) return s;
    }
    return null;
  }

  /**
   * What a new conversation starts with (FR-3.5, FR-12.2·12.6): the default runtime with its default model; else
   * the same runtime's first usable allowed model in the model-list order; else the other runtimes in the order
   * Claude Code → Codex, each with the user's default model for it (else its first usable allowed model); else
   * nothing (null: "쓸 수 있는 런타임이 없어요"). `fallback` = the default runtime·model itself was not usable;
   * `limitedUntil` = it was because of a usage limit, until then. A default runtime without a saved model starts on
   * its first allowed model — that is the default, not a fallback.
   */
  start(user: UserRow): StartSettings | null {
    const { defaults } = this.resolved(user);
    const first = defaults.runtime;
    const saved = defaults.models[first];
    const none = { model: null, effort: null };
    const seen: { limitedUntil?: number } = {};
    const exact = saved
      ? this.withDefault(user.id, first, saved, seen)
      : this.attempt(user.id, first, {}, none, seen);
    if (exact) return { settings: exact, fallback: false };
    const fell = (settings: ChatSettings): StartSettings => ({
      settings,
      fallback: true,
      ...(seen.limitedUntil !== undefined ? { limitedUntil: seen.limitedUntil } : {}),
    });
    // 1. the same runtime, its first usable allowed model (the model-list order)
    const sameRuntime = this.firstUsable(user.id, first, saved);
    if (sameRuntime) return fell(sameRuntime);
    // 2. the other runtimes, Claude Code → Codex: the user's default model there, else its first usable one
    for (const runtime of RUNTIME_ORDER) {
      if (runtime === first) continue;
      const d = defaults.models[runtime];
      const s = (d && this.withDefault(user.id, runtime, d)) ?? this.firstUsable(user.id, runtime, d);
      if (s) return fell(s);
    }
    return null;
  }

  /**
   * The chip's change of a conversation (FR-3.5, FR-12.3, #19), from its next message on. Explicit values that are
   * not allowed — runtime, model, an effort the model does not take or the admin does not allow, "공용으로 쓰기"
   * without a shared connection — throw `RunAccessDenied` (403). Changing only the runtime brings that runtime's
   * default model (and effort); changing only the model brings that model's default effort. `current` = the
   * conversation's settings (null for one that had none yet: its start settings are the base).
   */
  change(user: UserRow, current: ChatSettings | null, patch: ChangeSettingsRequest): ChatSettings {
    const base = current ?? this.start(user)?.settings ?? null;
    const runtime = patch.runtime ?? base?.runtime;
    if (!runtime) throw new RunAccessDenied("runtime_not_allowed");
    const { defaults } = this.resolved(user);
    const saved = defaults.models[runtime];
    const runtimeChanged = runtime !== base?.runtime;
    const requested: RunChoice = {};
    if (patch.model !== undefined) requested.model = patch.model;
    if (patch.effort !== undefined) requested.effort = patch.effort;
    // "공용으로 쓰기" is per runtime: another runtime starts again on the personal connection first.
    const useShared = patch.useShared ?? (runtimeChanged ? false : (base?.useShared ?? false));
    if (useShared) requested.useShared = true;
    let preference: { model: string | null; effort: string | null };
    if (patch.model !== undefined) {
      const sameModel = !runtimeChanged && patch.model === base?.model;
      preference = sameModel
        ? { model: base!.model, effort: base!.effort }
        : saved?.model === patch.model
          ? { model: saved.model, effort: saved.effort }
          : { model: patch.model, effort: null };
    } else if (runtimeChanged) preference = { model: saved?.model ?? null, effort: saved?.effort ?? null };
    else preference = { model: base?.model ?? null, effort: base?.effort ?? null };
    // Moving onto another runtime, model or connection checks its usage limit; changing only the effort of what the
    // conversation is already on does not (the limit is already in its way, and the chip says so).
    const moves =
      runtimeChanged ||
      (patch.model !== undefined && patch.model !== base?.model) ||
      (patch.useShared !== undefined && patch.useShared !== base?.useShared);
    try {
      return this.settle(user.id, runtime, requested, preference, { limit: moves });
    } catch (e) {
      // Only the runtime was picked and its default model is at a limit: its first model that is not (FR-12.3).
      if (!(e instanceof LimitedError) || patch.model !== undefined || patch.effort !== undefined) throw e;
      for (const m of this.caps(runtime)?.models ?? []) {
        const s = this.attempt(
          user.id,
          runtime,
          { ...requested, model: m.id },
          { model: m.id, effort: null },
        );
        if (s) return s;
      }
      throw e;
    }
  }
}
