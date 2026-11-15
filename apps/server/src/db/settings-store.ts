import { eq } from "drizzle-orm";
import { decrypt, encrypt } from "../crypto/secrets.js";
import type { Db } from "./client.js";
import { settings } from "./schema.js";

/** Plain and encrypted service settings. Encrypted values are bound to their key via AAD. */
export class SettingsStore {
  constructor(
    private readonly db: Db,
    private readonly masterKey: Buffer,
  ) {}

  get(key: string): string | undefined {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    if (!row) return undefined;
    return row.encrypted ? decrypt(row.value, this.masterKey, `setting:${key}`) : row.value;
  }

  set(key: string, value: string): void {
    this.upsert(key, value, false);
  }

  setSecret(key: string, value: string): void {
    this.upsert(key, encrypt(value, this.masterKey, `setting:${key}`), true);
  }

  private upsert(key: string, value: string, encrypted: boolean): void {
    this.db
      .insert(settings)
      .values({ key, value, encrypted, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: settings.key, set: { value, encrypted, updatedAt: Date.now() } })
      .run();
  }
}
