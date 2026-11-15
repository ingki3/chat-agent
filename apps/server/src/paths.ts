/**
 * Path of a request URL as the router sees it: query string removed and percent-encoding decoded
 * (Fastify matches `/%61pi/x` against `/api/x`, so security checks must decode too).
 */
export function routerPath(url: string | undefined): string {
  const raw = (url ?? "/").split("?")[0] ?? "/";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** True for `/api` and `/api/...` (query string ignored, percent-encoding decoded). */
export function isApiPath(url: string | undefined): boolean {
  const pathname = routerPath(url);
  return pathname === "/api" || pathname.startsWith("/api/");
}

/** API request by URL or by the matched route pattern — either one makes it an API request. */
export function isApiRequest(req: { url: string; routeOptions?: { url?: string | undefined } }): boolean {
  return isApiPath(req.url) || (req.routeOptions?.url !== undefined && isApiPath(req.routeOptions.url));
}

/** `/a/...` — artifact pages and originals (#27), always answered by Fastify routes (never the SPA fallback). */
export function isArtifactPath(url: string | undefined): boolean {
  return routerPath(url).startsWith("/a/");
}
