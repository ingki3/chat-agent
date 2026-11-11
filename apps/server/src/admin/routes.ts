import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { ConnectionStatus, RuntimeId, type AdminRuntime, type SystemStatus } from "@agentlee/shared";
import type { ConnectionStore } from "../connections/store.js";
import type { ErrorLog } from "../observability/errors.js";
import { tunnelStatus, type MetricsAddress, type TunnelStatus } from "../observability/tunnel.js";
import type { RuntimeRegistry } from "../runtime/adapter.js";

export type SystemRouteOptions = {
  version: string;
  startedAt: number;
  dataDir: string;
  /** The SQLite file (null for an in-memory database). */
  databaseFile: string | null;
  tunnelMetrics: MetricsAddress | undefined;
  /** Tests: the tunnel probe. */
  tunnel?: (address: MetricsAddress | undefined) => Promise<TunnelStatus>;
};

const RUNTIMES = RuntimeId.options;

function fileBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Admin screen (#35): the runtimes tab's model list and capabilities, and the system status (FR-10.4). Admin only;
 * the answers hold codes, counts, labels and masked state — never a credential, an error message or content.
 */
export function registerAdminSystemRoutes(
  app: FastifyInstance,
  deps: { registry: RuntimeRegistry; connections: ConnectionStore; errors: ErrorLog },
  opts: SystemRouteOptions,
): void {
  const admin = (what: string) => ({ auth: "admin" as const, noResource: what });

  app.get("/api/admin/runtimes", { config: admin("admin-only runtime model list") }, async (_req, reply) => {
    const items: AdminRuntime[] = RUNTIMES.map((runtime) => {
      const caps = deps.registry.get(runtime)?.capabilities();
      return {
        runtime,
        registered: !!caps,
        models: (caps?.models ?? []).map((m) => ({
          id: m.id,
          label: m.label,
          efforts: m.efforts,
          defaultEffort: m.defaultEffort ?? null,
        })),
        capabilities: {
          canResume: caps?.canResume ?? false,
          canSwitchModelInSession: caps?.canSwitchModelInSession ?? false,
          usesTools: caps?.usesTools ?? false,
          needsConnection: caps?.needsConnection ?? false,
        },
      };
    });
    return reply.header("Cache-Control", "no-store").send({ items });
  });

  app.get("/api/admin/system", { config: admin("admin-only system status") }, async (_req, reply) => {
    const shared = deps.connections.shared();
    const personal = deps.connections.allPersonal();
    const disk = await diskUsage(opts.dataDir);
    const body: SystemStatus = {
      version: opts.version,
      startedAt: opts.startedAt,
      uptimeSec: Math.round((Date.now() - opts.startedAt) / 1000),
      runtimes: RUNTIMES.map((runtime) => {
        const counts = Object.fromEntries(ConnectionStatus.options.map((s) => [s, 0])) as Record<
          ConnectionStatus,
          number
        >;
        for (const c of personal) if (c.runtime === runtime) counts[c.status]++;
        return {
          runtime,
          registered: !!deps.registry.get(runtime),
          shared: shared
            .filter((c) => c.runtime === runtime)
            .map((c) => ({
              id: c.id,
              label: c.label,
              status: c.status,
              lastTestCode: c.lastTestCode ?? null,
              lastTestAt: c.lastTestAt ?? null,
            })),
          personal: counts,
        };
      }),
      tunnel: await (opts.tunnel ?? tunnelStatus)(opts.tunnelMetrics),
      recentErrors: deps.errors.recent({ limit: 20 }).map((e) => ({
        id: e.id,
        at: e.at,
        source: e.source,
        code: e.code,
        category: e.category,
        runtime: e.runtime,
        tool: e.tool,
        route: e.route,
        statusCode: e.statusCode,
      })),
      skillFailures: deps.errors.skillFailures(),
      disk: {
        ...disk,
        databaseBytes: opts.databaseFile
          ? fileBytes(opts.databaseFile) + fileBytes(`${opts.databaseFile}-wal`)
          : null,
      },
    };
    return reply.header("Cache-Control", "no-store").send(body);
  });
}

/** The file system holding the data folder (FR-10.4 디스크 사용량); nulls when it cannot be read. */
async function diskUsage(dir: string): Promise<{ totalBytes: number | null; freeBytes: number | null }> {
  try {
    const s = await fs.promises.statfs(dir);
    return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
  } catch {
    return { totalBytes: null, freeBytes: null };
  }
}
