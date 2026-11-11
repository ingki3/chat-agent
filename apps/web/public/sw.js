// Agent Lee service worker (#13): keeps the app shell available offline. It never caches API responses,
// streams or anything personal — only the built static files and the page itself.
// Web push (#34): shows pushed notifications and opens their in-app address when tapped.
const CACHE = "agentlee-shell-v1";
/** Push bookkeeping shared with the page (not app data): a failed re-registration waiting for the app. */
const PUSH_STATE = "agentlee-push";
const REREGISTER = "/push-reregister";

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
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE && k !== PUSH_STATE).map((k) => caches.delete(k))),
      )
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

const singlePath = (p) => p.startsWith("/") && !p.startsWith("//") && !p.includes("\\");

/** Same-origin in-app path only; anything else opens the app's start page. */
function inAppPath(url) {
  if (typeof url !== "string" || !singlePath(url)) return "/";
  try {
    const u = new URL(url, self.location.origin);
    const out = u.pathname + u.search + u.hash;
    // Dot segments can normalise "/a/..//host" into "//host" (another site): check the result again.
    return u.origin === self.location.origin && singlePath(out) ? out : "/";
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

const post = (path, body) =>
  fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "x-agent-lee": "1" },
    body: JSON.stringify(body),
  });

/**
 * Tapping a notification. An open app window is *navigated* to the address (a real page load, whatever it shows
 * now — the login screen included), otherwise a new window opens there. If the app session has expired the
 * login screen shows on that address and the app renders it after login; an expired Cloudflare Access session
 * goes through Access's login, which returns to the same address.
 */
async function openFromNotification(url, id) {
  // Mark it read on the way (fails quietly when the session has expired).
  const read = id ? post(`/api/notifications/${encodeURIComponent(id)}/read`, {}).catch(() => {}) : null;
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const win = list.find((c) => new URL(c.url).origin === self.location.origin);
  if (!win) {
    await self.clients.openWindow(url);
  } else {
    try {
      const moved = await win.navigate(url);
      await (moved || win).focus().catch(() => {});
    } catch {
      // A window this worker does not control yet cannot be navigated: the page moves itself (App listener).
      await win.focus().catch(() => {});
      win.postMessage({ type: "agentlee:open", url });
    }
  }
  await read;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(
    openFromNotification(inAppPath(data.url), typeof data.id === "string" ? data.id : undefined),
  );
});

const BINDING = "/push-binding";

/** The session the subscription was turned on under (written by the app, apps/web/src/push.ts). */
async function readBinding() {
  try {
    const r = await caches.match(BINDING, { cacheName: PUSH_STATE });
    const v = r ? await r.json() : null;
    return v && typeof v.sessionTag === "string" ? v.sessionTag : null;
  } catch {
    return null;
  }
}

async function setReregisterPending(sessionTag) {
  try {
    const c = await caches.open(PUSH_STATE);
    if (sessionTag === undefined) await c.delete(REREGISTER);
    else
      await c.put(
        REREGISTER,
        new Response(JSON.stringify({ sessionTag }), { headers: { "Content-Type": "application/json" } }),
      );
  } catch {
    // storage unavailable: the app compares the subscription with the server on its next start anyway
  }
}

/**
 * The browser replaced the subscription (expiry, key rotation by the push service): register the new one — for
 * the login session it was turned on under only. The request names that session's tag; if the browser is now
 * signed in to another session or account the server refuses (409), so a device never moves to whoever happens
 * to be signed in. If registering fails (offline, 401/403 after the app or Access session ran out, 409), a
 * marker naming that session is left, and the app registers again on its next start *in that same session*
 * (apps/web/src/push.ts `syncPush`); any other session drops the marker.
 */
async function reRegister(oldSub, newSub) {
  const sessionTag = await readBinding();
  try {
    if (!sessionTag) throw new Error("not turned on in a known session");
    let sub = newSub;
    if (!sub) {
      const key = oldSub && oldSub.options ? oldSub.options.applicationServerKey : null;
      if (!key) throw new Error("no key to subscribe again");
      sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
    }
    const res = await post("/api/push/devices", { ...sub.toJSON(), label: "다시 등록된 기기", sessionTag });
    if (!res.ok) throw new Error(`registration answered ${res.status}`);
    await setReregisterPending(undefined);
  } catch {
    await setReregisterPending(sessionTag);
  }
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(reRegister(event.oldSubscription, event.newSubscription));
});
