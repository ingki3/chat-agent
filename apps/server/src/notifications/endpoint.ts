import net from "node:net";

/**
 * Push endpoints the server will POST to (#34). `web-push` makes its own HTTPS request, so the endpoint a
 * browser hands us is checked up front: https on the default port, no credentials, and a host of one of the
 * browser push services — never an IP literal, loopback, private or internal name. Otherwise a subscription
 * would let any logged-in user make the server send requests into the home network.
 */
const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge (Android/desktop), Samsung Internet
  "android.googleapis.com", // older Chrome
  "updates.push.services.mozilla.com", // Firefox
  "push.services.mozilla.com",
  "web.push.apple.com", // Safari / iOS home-screen apps (16.4+)
];
/** Suffixes of push services that hand out per-region hosts. */
const PUSH_SERVICE_SUFFIXES = [".push.apple.com", ".notify.windows.com", ".push.services.mozilla.com"];

export function isAllowedPushHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    PUSH_SERVICE_HOSTS.includes(h) || PUSH_SERVICE_SUFFIXES.some((s) => h.endsWith(s) && h.length > s.length)
  );
}

export function validPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  // An IP literal is never a push service (public or private): refused outright.
  if (net.isIP(host)) return false;
  return isAllowedPushHost(host);
}
