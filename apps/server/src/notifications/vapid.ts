import webpush from "web-push";
import type { SettingsStore } from "../db/settings-store.js";

/**
 * VAPID keys (#34): generated once, on first start, and kept in the settings table — the public key as is, the
 * private key encrypted with the master key (AES-256-GCM, AAD `setting:push.vapid.private`). Browsers bind
 * their subscriptions to the public key, so changing it means every device has to turn notifications on again
 * (docs/ops.md §12).
 */
export const VAPID_PUBLIC = "push.vapid.public";
export const VAPID_PRIVATE = "push.vapid.private";

export type VapidKeys = { publicKey: string; privateKey: string };

export function loadOrCreateVapidKeys(
  settings: SettingsStore,
  generate: () => VapidKeys = () => webpush.generateVAPIDKeys(),
): VapidKeys {
  const publicKey = settings.get(VAPID_PUBLIC);
  const privateKey = settings.get(VAPID_PRIVATE);
  if (publicKey && privateKey) return { publicKey, privateKey };
  const keys = generate();
  settings.setSecret(VAPID_PRIVATE, keys.privateKey);
  settings.set(VAPID_PUBLIC, keys.publicKey);
  return keys;
}
