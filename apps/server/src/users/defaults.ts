import {
  SERVICE_DEFAULTS,
  type DefaultsResponse,
  type RuntimeDefaults,
  type RuntimeId,
} from "@agentlee/shared";
import { storedDefaults, type UserRow } from "../auth/users.js";
import type { RunAccess } from "../connections/access.js";
import type { RuntimeCapabilities, RuntimeRegistry } from "../runtime/adapter.js";

/**
 * Default runtime, model and effort (PRD D3, FR-12.1·12.3·12.4, #35). The user's own choice wins, then the admin's
 * initial value for that user, then the service default (Claude Code · Opus 5.5). Saving either one goes through
 * `RunAccess.checkDefaults` — the same allowed list as the run check and the picker — so a model the admin did not
 * allow can never be saved (403 for the user, 400 for the admin). Applying them to new conversations, with the
 * FR-12.6 fallback order, is #19.
 */
export class DefaultsService {
  constructor(
    private readonly access: RunAccess,
    private readonly registry: RuntimeRegistry,
  ) {}

  private caps = (runtime: RuntimeId): RuntimeCapabilities | undefined =>
    this.registry.get(runtime)?.capabilities();

  effective(user: UserRow): DefaultsResponse {
    const own = storedDefaults(user.defaults);
    const initial = storedDefaults(user.initialDefaults);
    const [defaults, source] = own
      ? ([own, "own"] as const)
      : initial
        ? ([initial, "initial"] as const)
        : ([SERVICE_DEFAULTS, "service"] as const);
    // Only a saved value can have become unusable; the service default is whatever the server offers.
    const unavailable =
      source === "service" ? [] : this.access.unavailableDefaults(user.id, defaults, this.caps);
    return { defaults, source, unavailable };
  }

  /** Throws `RunAccessDenied` when `defaults` is not allowed for `userId`. */
  check(userId: string, defaults: RuntimeDefaults): void {
    this.access.checkDefaults(userId, defaults, this.caps);
  }
}
