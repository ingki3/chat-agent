import type { Role } from "@agentlee/shared";

/**
 * Access policy for user-owned resources (PRD FR-1.5, NFR 권한, issue #10). One function decides for every
 * resource API — originals, versions, downloads and streams alike.
 * - owner: everything
 * - shared: read only — loaders fill `sharedWith` from the share projection (#29, shares/projection.ts), and the
 *   handlers cut what a shared viewer is sent to the same projection
 * - admin: usage numbers only (`usage`), never the content of someone else's resource
 */
export type Action = "read" | "write" | "delete" | "share" | "usage";

export type ResourceRef = {
  kind: string;
  id: string;
  ownerId: string;
  /** Users the resource is shared with (read access). */
  sharedWith?: readonly string[];
  /**
   * The conversation the resource belongs to (#29): a share change there (`resource-access-changed` with this
   * `scope`) makes open streams on the resource re-check, whatever its own kind.
   */
  scope?: string;
};

export type Actor = { id: string; role: Role; active: boolean };

export function can(user: Actor, action: Action, resource: ResourceRef): boolean {
  if (!user.active) return false;
  if (resource.ownerId === user.id) return true;
  if (action === "read" && resource.sharedWith?.includes(user.id)) return true;
  if (action === "usage" && user.role === "admin") return true;
  return false;
}
