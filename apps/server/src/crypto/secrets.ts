import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Encryption for stored credentials (PRD FR-11.6, FR-15.6): AES-256-GCM with a random 96-bit IV.
 * Format: "v1:" + base64(iv | authTag | ciphertext). The optional AAD binds a value to its owner/purpose
 * (e.g. "connection:<id>") so a ciphertext copied to another row fails to decrypt.
 */
const VERSION = "v1";
const IV_LEN = 12;
const TAG_LEN = 16;
export const KEY_LEN = 32;

export class SecretError extends Error {}

export function encrypt(plaintext: string, key: Buffer, aad?: string): string {
  assertKey(key);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

export function decrypt(payload: string, key: Buffer, aad?: string): string {
  assertKey(key);
  const [version, body] = payload.split(":", 2);
  if (version !== VERSION || !body) throw new SecretError("unsupported secret format");
  const raw = Buffer.from(body, "base64");
  if (raw.length < IV_LEN + TAG_LEN) throw new SecretError("secret payload too short");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_LEN));
  decipher.setAuthTag(raw.subarray(IV_LEN, IV_LEN + TAG_LEN));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  try {
    return Buffer.concat([decipher.update(raw.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new SecretError("secret failed authentication (wrong key, wrong context or tampered)");
  }
}

/** What the UI may show for a credential: the last 4 characters only. */
export function mask(value: string): string {
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_LEN) throw new SecretError(`master key must be ${KEY_LEN} bytes`);
}

/**
 * Reads the master key file (base64, 32 bytes). The file must not be readable by group/others, and must
 * live outside the data directory so backups never contain it (PRD NFR 가용성·백업).
 */
export function loadMasterKey(keyPath: string): Buffer {
  const st = fs.statSync(keyPath);
  if ((st.mode & 0o077) !== 0) {
    throw new SecretError(
      `master key ${keyPath} must have mode 600 (found ${(st.mode & 0o777).toString(8)})`,
    );
  }
  const key = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64");
  assertKey(key);
  return key;
}

/** Creates a new master key file with mode 600. Refuses to overwrite an existing key. */
export function createMasterKey(keyPath: string): Buffer {
  if (fs.existsSync(keyPath)) throw new SecretError(`master key already exists at ${keyPath}`);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(KEY_LEN);
  fs.writeFileSync(keyPath, key.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  return key;
}
