import type { PushDevice } from "@agentlee/shared";
import { push } from "./api.js";
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
  constructor(readonly reason: "denied" | "unsupported" | "failed") {
    super(reason);
  }
}

/**
 * "알림 켜기": asks for permission (this click is the only place that does), subscribes with the service's
 * VAPID key and registers the device for the signed-in account and session.
 */
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new PushSetupError("unsupported");
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
  await push.register(sub.toJSON(), deviceLabel());
}

function sameKey(sub: PushSubscription, publicKey: string): boolean {
  const k = sub.options.applicationServerKey;
  if (!k) return true;
  const a = new Uint8Array(k);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Where the service worker leaves a note when re-registering a renewed subscription failed (sw.js). */
const PUSH_STATE = "agentlee-push";
const REREGISTER = "/push-reregister";

async function reregisterPending(): Promise<boolean> {
  try {
    return !!(await caches.match(REREGISTER, { cacheName: PUSH_STATE }));
  } catch {
    return false;
  }
}

async function clearReregisterPending(): Promise<void> {
  try {
    await (await caches.open(PUSH_STATE)).delete(REREGISTER);
  } catch {
    // nothing to clear
  }
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The account's devices, after making the server match this browser's *real* subscription for this login session
 * (see push-reconcile.ts). Runs on every app start and settings visit, so a renewal the service worker could not
 * register (e.g. 403 after Access expired) is registered on the next start, and "켜짐" is only shown when this
 * browser really has the subscription the server will push to.
 */
export async function syncPush(): Promise<PushDevice[]> {
  let devices = await push.devices();
  if (!pushSupported()) return devices;
  // Not registered yet (first load, development build): nothing to compare.
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return devices;
  const sub = await reg.pushManager.getSubscription().catch(() => null);
  const usable = sub && Notification.permission === "granted" ? sub : null;
  const current = devices.find((d) => d.current);
  const pending = await reregisterPending();
  const action = reconcileAction({
    endpointHash: usable ? await sha256Hex(usable.endpoint) : null,
    current,
    pending,
  });
  if ((action === "remove" || action === "replace") && current) devices = await push.remove(current.id);
  if ((action === "register" || action === "replace") && usable)
    devices = await push.register(usable.toJSON(), deviceLabel());
  if (pending) await clearReregisterPending();
  return devices;
}

/** "끄기" on this device: the browser stops the subscription, the server forgets the device. */
export async function disablePush(deviceId: string | undefined): Promise<void> {
  const sub = await currentSubscription();
  await sub?.unsubscribe().catch(() => {});
  if (deviceId) await push.remove(deviceId);
}

/** Logging out: this browser stops receiving this account's pushes (the server also drops the device). */
export async function unsubscribeOnSignOut(): Promise<void> {
  try {
    const sub = await currentSubscription();
    await sub?.unsubscribe();
  } catch {
    // the server-side device is removed with the session anyway
  }
}
