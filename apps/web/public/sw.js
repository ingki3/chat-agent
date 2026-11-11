// Agent Lee service worker (#13): keeps the app shell available offline. It never caches API responses,
// streams or anything personal — only the built static files and the page itself.
// Web push (#34): shows pushed notifications and opens their in-app address when tapped.
const CACHE = "agentlee-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.add("/"))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/gate") return;
  // Pages: network first (always the latest app), the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/")));
    return;
  }
  // Hashed build assets never change: cache first.
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

// ---- Web push (#34) ----

/** Same-origin in-app path only; anything else opens the app's start page. */
function inAppPath(url) {
  if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//") || url.includes("\\"))
    return "/";
  try {
    const u = new URL(url, self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : "/";
  } catch {
    return "/";
  }
}

self.addEventListener("push", (event) => {
  let data;
  try {
    data = (event.data && event.data.json()) || {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Agent Lee";
  const url = inAppPath(data.url);
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, {
        body: typeof data.body === "string" ? data.body : "",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        lang: "ko",
        tag: typeof data.tag === "string" ? data.tag : undefined,
        data: { url, id: typeof data.id === "string" ? data.id : undefined },
      }),
      // Open app windows refresh the 🔔 badge at once.
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((list) => list.forEach((c) => c.postMessage({ type: "agentlee:notification" }))),
    ]),
  );
});

// Tapping a notification: reuse an open app window (the app navigates in place), otherwise open the address.
// If the app or Cloudflare Access session has expired, the normal login flow runs on that same address and
// returns there afterwards.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = inAppPath(data.url);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (list) => {
      const win = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (win) {
        await win.focus().catch(() => {});
        win.postMessage({ type: "agentlee:open", url, id: data.id });
        return;
      }
      await self.clients.openWindow(url);
    }),
  );
});

// The browser replaced the subscription (expiry, key rotation by the push service): register the new one.
self.addEventListener("pushsubscriptionchange", (event) => {
  const old = event.oldSubscription;
  const key = old && old.options ? old.options.applicationServerKey : null;
  if (!key) return;
  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: key })
      .then((sub) =>
        fetch("/api/push/devices", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "x-agent-lee": "1" },
          body: JSON.stringify({ ...sub.toJSON(), label: "다시 등록된 기기" }),
        }),
      )
      .catch(() => {}),
  );
});
