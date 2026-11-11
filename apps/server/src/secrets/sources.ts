import { isNotNull } from "drizzle-orm";
import type { Config } from "../config.js";
import { decrypt } from "../crypto/secrets.js";
import type { Db } from "../db/client.js";
import { connections, pushSubscriptions, settings } from "../db/schema.js";
import { knownSecrets, type KnownSecrets } from "./known.js";

/**
 * Where the known secrets come from (review round 23). At runtime every `encrypt`/`decrypt`, every MCP token, every
 * session cookie and the master key register themselves; these two fill the registry at startup with what the
 * server holds before any of that runs: `.env` secrets, and every credential stored encrypted in the database
 * (decrypting registers it).
 */
export function registerConfigSecrets(config: Config, registry: KnownSecrets = knownSecrets): void {
  registry.add(config.tempGateCode);
  for (const v of Object.values(config.skillSecrets)) registry.add(v);
  registry.add(config.claude?.apiKey);
  registry.add(config.claude?.oauthToken);
  registry.add(config.codex?.apiKey);
}

/** The master key, and every stored secret decrypted once (connections, encrypted settings, push subscriptions) to register it. */
export function primeStoredSecrets(db: Db, masterKey: Buffer): void {
  knownSecrets.addKey(masterKey);
  const tryDecrypt = (payload: string, aad: string) => {
    try {
      decrypt(payload, masterKey, aad); // registers the plaintext
    } catch {
      // a row that does not decrypt holds nothing this key knows
    }
  };
  for (const c of db.select().from(connections).where(isNotNull(connections.secret)).all())
    tryDecrypt(c.secret!, `connection:${c.id}:${c.runtime}:${c.authType}`);
  for (const s of db.select().from(settings).all()) if (s.encrypted) tryDecrypt(s.value, `setting:${s.key}`);
  for (const p of db.select().from(pushSubscriptions).all()) tryDecrypt(p.secret, `push:${p.id}`);
}
