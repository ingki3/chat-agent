/** Headers sent on every response, including hijacked ones (SSE) and Vite dev pages. */
export const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;
