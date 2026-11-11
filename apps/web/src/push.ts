import type { PushDeviceList } from "@agentlee/shared";
import { ApiError, push } from "./api.js";
import { reconcileAction } from "./push-reconcile.js";

/** Query key of this account's devices, already reconciled with the browser (`syncPush`). */
export const PUSH_DEVICES_KEY = ["push-devices"] as const;

/**
 * Web push on this device (#34, FR-13.1). The browser permission prompt is only ever opened from the
 * "알림 켜기" button (`enablePush`), never on page load.
 *
 * States of this device:
 * - `unsupported`: no service worker / Push API (old browser, private mode, development build)
 * - `ios-install`: iPhone/iPad Safari tab — push only works in the home-screen app (iOS 16.4+)
 * - `denied`: the user blocked notifications for this site (the app cannot ask again)
 * - `off`: allowed or not yet asked, but this device is not registered for this account
 * - `on`: registered — pushes for this account arrive here
 */
export type DeviceState = "unsupported" | "ios-install" | "denied" | "off" | "on";

const isIos = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  // iPadOS reports itself as a Mac with touch.
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** What the browser itself says, before asking the server. */
export function browserState(): Exclude<DeviceState, "on"> {
  if (isIos() && !isStandalone()) return "ios-install";
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return "off";
}

/** A short name for the device list, e.g. "iPhone · 홈 화면 앱", "Android · Chrome". */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "기기";
  if (isStandalone()) return `${os} · 홈 화면 앱`;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /SamsungBrowser\//.test(ua)
        ? "Samsung Internet"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "브라우저";
  return `${os} · ${browser}`;
}

/** The service worker registration, if the app registered one (production builds). */
async function registration(timeoutMs = 4000): Promise<ServiceWorkerRegistration | undefined> {
  if (!pushSupported()) return undefined;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<undefined>((r) => setTimeout(() => r(undefined), timeoutMs)),
  ]);
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  return (await registration(1500))?.pushManager.getSubscription() ?? null;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export class PushSetupError extends Error {
  constructor(
    readonly reason: "denied" | "unsupported" | "failed" | "session_changed" | "unsubscribe_failed",
  ) {
    super(reason);
  }
}

/**
 * "알림 켜기": asks for permission (this click is the only place that does), subscribes with the service's
 * VAPID key and registers the device for the signed-in account and session.
 */
export async function enablePush(sessionTag?: string): Promise<void> {
  if (!pushSupported()) throw new PushSetupError("unsupported");
  // The session this screen belongs to; if the browser has since signed in elsewhere the server refuses.
  const tag = sessionTag ?? (await push.devices()).sessionTag;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PushSetupError(permission === "denied" ? "denied" : "failed");
  const reg = await registration();
  if (!reg) throw new PushSetupError("unsupported");
  const publicKey = await push.key();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another key (keys were replaced on the server) cannot be used any more.
  if (sub && !sameKey(sub, publicKey)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  try {
    sub ??= await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    });
  } catch {
    throw new PushSetupError("failed");
  }
  let list: PushDeviceList;
  try {
    list = await push.register(sub.toJSON(), deviceLabel(), tag);
  } catch (e) {
    if (isSessionChanged(e)) throw new PushSetupError("session_changed");
    throw e;
  }
  await writeState(BINDING, { sessionTag: list.sessionTag });
}

const isSessionChanged = (e: unknown) =>
  e instanceof ApiError && e.status === 409 && e.code === "session_changed";

function sameKey(sub: PushSubscription, publicKey: string): boolean {
  const k = sub.options.applicationServerKey;
  if (!k) return true;
  const a = new Uint8Array(k);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Push bookkeeping shared with the service worker (sw.js), in Cache Storage:
 * - `/push-binding` `{ sessionTag }`: the login session this browser's subscription was turned on under;
 * - `/push-reregister` `{ sessionTag }`: the worker could not register a renewed subscription for that session.
 */
const PUSH_STATE = "agentlee-push";
const BINDING = "/push-binding";
const REREGISTER = "/push-reregister";
type Marker = { sessionTag: string | null };

async function readState(key: string): Promise<Marker | null> {
  try {
    const r = await caches.match(key, { cacheName: PUSH_STATE });
    if (!r) return null;
    const v = (await r.json().catch(() => ({}))) as { sessionTag?: unknown };
    return { sessionTag: typeof v.sessionTag === "string" ? v.sessionTag : null };
  } catch {
    return null;
  }
}

async function writeState(key: string, value: Marker | null): Promise<void> {
  try {
    const c = await caches.open(PUSH_STATE);
    if (value)
      await c.put(
        key,
        new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }),
      );
    else await c.delete(key);
  } catch {
    // storage unavailable: recovery falls back to the button
  }
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The account's devices, after making the server match this browser's *real* subscription for this login session
 * (see push-reconcile.ts). Runs on every app start and settings visit, so a renewal the service worker could not
 * register (e.g. 403 after Access expired) is registered on the next start of the *same* session, and "켜짐" is
 * only shown when this browser really has the subscription the server will push to.
 */
export async function syncPush(): Promise<PushDeviceList> {
  let list = await push.devices();
  if (!pushSupported()) return list;
  // Not registered yet (first load, development build): nothing to compare.
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return list;
  // Everything below is for the session read here: every registration sends its tag, so if the browser signs in
  // to another session or account meanwhile (another tab), the server refuses instead of binding it there.
  const sessionTag = list.sessionTag;
  const sub = await reg.pushManager.getSubscription().catch(() => null);
  const usable = sub && Notification.permission === "granted" ? sub : null;
  const current = list.devices.find((d) => d.current);
  const marker = await readState(REREGISTER);
  const match = usable && current ? await push.check(await sha256Hex(usable.endpoint)) : false;
  const action = reconcileAction({
    hasSubscription: !!usable,
    current: !!current,
    match,
    marker,
    sessionTag,
  });
  try {
    if (action === "remove" && current) list = await push.remove(current.id);
    // On failure this throws before the marker is cleared; a failed replace leaves the old row (server transaction).
    if (action === "register" && usable)
      list = await push.register(usable.toJSON(), deviceLabel(), sessionTag);
    if (action === "replace" && usable && current)
      list = await push.register(usable.toJSON(), deviceLabel(), sessionTag, current.id);
  } catch (e) {
    if (!isSessionChanged(e)) throw e;
    // Another session took over this browser: drop every recovery intent of the old one and stay off.
    await writeState(REREGISTER, null);
    await writeState(BINDING, null);
    return push.devices();
  }
  if (marker) await writeState(REREGISTER, null);
  const on = !!usable && (action === "register" || action === "replace" || (action === "none" && match));
  await writeState(BINDING, on ? { sessionTag } : null);
  return list;
}

/** "끄기" on this device: the browser stops the subscription, the server forgets the device. */
export async function disablePush(deviceId: string | undefined): Promise<void> {
  // An explicit "off" discards every recovery intent first: nothing may turn this device on again by itself.
  await writeState(REREGISTER, null);
  await writeState(BINDING, null);
  let unsubscribed = true;
  try {
    const sub = await currentSubscription();
    if (sub && !(await sub.unsubscribe())) unsubscribed = false;
  } catch {
    unsubscribed = false;
  }
  if (deviceId) await push.remove(deviceId);
  // The server no longer pushes here either way; say that the browser kept its subscription.
  if (!unsubscribed) throw new PushSetupError("unsubscribe_failed");
}

/** Logging out: this browser stops receiving this account's pushes (the server also drops the device). */
export async function unsubscribeOnSignOut(): Promise<void> {
  await writeState(BINDING, null);
  await writeState(REREGISTER, null);
  try {
    const sub = await currentSubscription();
    await sub?.unsubscribe();
  } catch {
    // the server-side device is removed with the session anyway
  }
}
