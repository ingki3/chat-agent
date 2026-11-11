import type { FastifyInstance, FastifyReply } from "fastify";
import {
  RevertArtifactRequest,
  type ArtifactDetail,
  type ArtifactListResponse,
  type ArtifactVersionContent,
} from "@agentlee/shared";
import { deny } from "../auth/plugin.js";
import type { ConversationStore } from "../conversations/store.js";
import { BASE_HEADERS } from "../headers.js";
import { artifactCsp, attachment, downloadVersion, serveVersion } from "./serve.js";
import { ArtifactError, toArtifact, toVersionInfo, type ArtifactStore } from "./store.js";

/** Resource kind of one artifact (owner only until sharing, #29, fills `sharedWith`). */
export const ARTIFACT_KIND = "artifact";
/** Resource kind of a conversation's artifact list: owner only (a shared view gets its own projection, #29). */
export const CONVERSATION_ARTIFACTS_KIND = "conversation-artifacts";

/** Headers of every served original or download, besides its CSP (`serve.ts`). */
export const RAW_HEADERS = {
  ...BASE_HEADERS,
  "Cache-Control": "no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()",
} as const;

/** The SPA page (index.html) for an app route, and whether it exists; set by buildApp once the UI is known. */
export type AppPage = (url: string) => Promise<string | Buffer | undefined>;

const VERSION = /^[1-9][0-9]{0,5}$/;
const notFound = (reply: FastifyReply) =>
  reply.code(404).header("Cache-Control", "no-store").send({ error: "not_found" });

/**
 * Artifact API and pages (#27):
 * - `GET /api/conversations/:id/artifacts` — the conversation's artifacts (owner only)
 * - `GET /api/artifacts/:id` — one artifact with its versions; `GET /api/artifacts/:id/versions/:version` — one
 *   version's stored text as JSON (never rendered by the app)
 * - `POST /api/artifacts/:id/revert` `{ version }` — copy an earlier version as the newest
 * - `GET /a/:id` — the app page (viewer); `GET /a/:id/v/:version/raw` — the sandboxed original;
 *   `GET /a/:id/v/:version/download` — the file
 */
export function registerArtifactRoutes(
  app: FastifyInstance,
  conversations: ConversationStore,
  store: ArtifactStore,
  appPage: AppPage,
): void {
  app.resources.register(ARTIFACT_KIND, (id) => {
    const a = store.get(id);
    return a ? { kind: ARTIFACT_KIND, id: a.id, ownerId: a.userId, sharedWith: [] } : undefined;
  });
  app.resources.register(CONVERSATION_ARTIFACTS_KIND, (id) => {
    const c = conversations.get(id);
    return c
      ? { kind: CONVERSATION_ARTIFACTS_KIND, id: c.id, ownerId: c.ownerId, sharedWith: [] }
      : undefined;
  });
  const read = { resource: { kind: ARTIFACT_KIND, action: "read" as const } };

  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id/artifacts",
    { config: { resource: { kind: CONVERSATION_ARTIFACTS_KIND, action: "read" } } },
    async (req, reply) =>
      reply
        .header("Cache-Control", "no-store")
        .send({ items: store.list(req.params.id).map(toArtifact) } satisfies ArtifactListResponse),
  );

  app.get<{ Params: { id: string } }>("/api/artifacts/:id", { config: read }, async (req, reply) => {
    const a = store.get(req.params.id)!;
    const detail: ArtifactDetail = { ...toArtifact(a), versions: store.versions(a.id).map(toVersionInfo) };
    return reply.header("Cache-Control", "no-store").send(detail);
  });

  app.get<{ Params: { id: string; version: string } }>(
    "/api/artifacts/:id/versions/:version",
    { config: read },
    async (req, reply) => {
      const v = VERSION.test(req.params.version)
        ? store.version(req.params.id, Number(req.params.version))
        : undefined;
      if (!v) return notFound(reply);
      const a = store.get(req.params.id)!;
      return reply
        .header("Cache-Control", "no-store")
        .send({ version: v.version, kind: a.kind, content: v.content } satisfies ArtifactVersionContent);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/artifacts/:id/revert",
    { config: { resource: { kind: ARTIFACT_KIND, action: "write" } } },
    async (req, reply) => {
      const body = RevertArtifactRequest.safeParse(req.body);
      if (!body.success) return deny(reply, 400, "invalid_request");
      try {
        const { artifact } = store.revert(req.params.id, body.data.version);
        const detail: ArtifactDetail = {
          ...toArtifact(artifact),
          versions: store.versions(artifact.id).map(toVersionInfo),
        };
        return reply.header("Cache-Control", "no-store").send(detail);
      } catch (e) {
        if (!(e instanceof ArtifactError)) throw e;
        if (e.code === "artifact_not_found") return notFound(reply);
        return reply.code(409).header("Cache-Control", "no-store").send({ error: e.code });
      }
    },
  );

  // The viewer is the SPA (apps/web ArtifactPage); refusals keep their status and show the SPA too (login, 403).
  const sendPage = async (reply: FastifyReply, url: string, status: number) => {
    const html = await appPage(url);
    reply.code(status).header("Cache-Control", "no-store").type("text/html; charset=utf-8");
    return reply.send(html ?? "<!doctype html><title>Agent Lee</title>");
  };
  app.get<{ Params: { id: string } }>(
    "/a/:id",
    {
      config: {
        ...read,
        deniedPage: (reply, status) => sendPage(reply, reply.request.url, status),
      },
    },
    async (req, reply) => sendPage(reply, req.url, 200),
  );

  app.get<{ Params: { id: string; version: string } }>(
    "/a/:id/v/:version/raw",
    { config: read },
    async (req, reply) => {
      const a = store.get(req.params.id)!;
      const v = VERSION.test(req.params.version)
        ? store.version(a.id, Number(req.params.version))
        : undefined;
      const served = v && serveVersion(a.kind, v.title, v.content);
      if (!served) return notFound(reply);
      // The CSP set here is kept by the app's onSend hook (it adds the app CSP only where none is set).
      return reply
        .headers(RAW_HEADERS)
        .header(
          "Content-Security-Policy",
          // One header line per policy (Fastify sends an array as repeated headers).
          served.csp.length === 1 ? served.csp[0]! : [...served.csp],
        )
        .type(served.type)
        .send(served.body);
    },
  );

  app.get<{ Params: { id: string; version: string } }>(
    "/a/:id/v/:version/download",
    { config: read },
    async (req, reply) => {
      const a = store.get(req.params.id)!;
      const v = VERSION.test(req.params.version)
        ? store.version(a.id, Number(req.params.version))
        : undefined;
      const file = v && downloadVersion(a.kind, v.content, v.language ?? null);
      if (!v || !file) return notFound(reply);
      return (
        reply
          .headers(RAW_HEADERS)
          // A download is never rendered by the app; if a browser shows it anyway it is as sandboxed as the original.
          .header("Content-Security-Policy", artifactCsp([]))
          .header("Content-Disposition", attachment(v.title, file.ext))
          .type(file.type)
          .send(file.body)
      );
    },
  );
}
