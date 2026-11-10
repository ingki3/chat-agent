/** True for `/api` and `/api/...` (query string ignored). */
export function isApiPath(url: string | undefined): boolean {
  const pathname = (url ?? "/").split("?")[0] ?? "/";
  return pathname === "/api" || pathname.startsWith("/api/");
}
