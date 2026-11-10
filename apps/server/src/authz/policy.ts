import type { Role } from "@agentlee/shared";

/**
 * Access policy for user-owned resources (PRD FR-1.5, NFR 권한, issue #10). One function decides for every
 * resource API — originals, versions, downloads and streams alike.
 * - owner: everything
 * - shared: read only (the shared projection is #29's job; loaders return who it is shared with)
 * - admin: usage numbers only (`usage`), never the content of someone else's resource
 */
export type Action = "read" | "write" | "delete" | "share" | "usage";

export type ResourceRef = {
  kind: string;
  id: string;
  ownerId: string;
  /** Users the resource is shared with (read access). */
  sharedWith?: readonly string[];
};

export type Actor = { id: string; role: Role; active: boolean };

export function can(user: Actor, action: Action, resource: ResourceRef): boolean {
  if (!user.active) return false;
  if (resource.ownerId === user.id) return true;
  if (action === "read" && resource.sharedWith?.includes(user.id)) return true;
  if (action === "usage" && user.role === "admin") return true;
  return false;
}
