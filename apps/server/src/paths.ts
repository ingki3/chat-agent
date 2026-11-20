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

/**
 * A public artifact link's path (#204): exactly `/artifact/<token>`, `/artifact/<token>/raw` or
 * `/artifact/<token>/download` — a well-formed token, nothing before or after (query string ignored, percent-encoding
 * decoded as the router does). `/artifact`, `/artifacts` (the app's list page), `/artifact/` alone, other suffixes or a
 * malformed token are not: they stay behind Access and the app login like every other path.
 */
const PUBLIC_LINK_PATH = /^\/artifact\/[A-Za-z0-9_-]{43}(?:\/raw|\/download)?$/;
export function isPublicLinkPath(url: string | undefined): boolean {
  return PUBLIC_LINK_PATH.test(routerPath(url));
}
