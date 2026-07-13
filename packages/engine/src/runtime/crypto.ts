import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export interface EncryptedRecord {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
}

export class RuntimeContentLockedError extends Error {
  constructor() {
    super("runtime content is locked: the project trace key is unavailable");
    this.name = "RuntimeContentLockedError";
  }
}

export class RuntimeContentTamperedError extends Error {
  constructor() {
    super("runtime content authentication failed");
    this.name = "RuntimeContentTamperedError";
  }
}

export function decodeRuntimeKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES || key.toString("base64") !== encoded) {
    throw new Error("runtime trace key must be canonical base64 for exactly 32 bytes");
  }
  return key;
}

export function assertRuntimeKey(key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) {
    throw new Error(`runtime trace key must contain exactly ${KEY_BYTES} bytes`);
  }
  return Buffer.from(key);
}

export function encryptRecord(key: Buffer, plaintext: Buffer, aad: string): EncryptedRecord {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", assertRuntimeKey(key), nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}

export function decryptRecord(
  key: Buffer | undefined,
  encrypted: EncryptedRecord,
  aad: string,
): Buffer {
  if (key === undefined) throw new RuntimeContentLockedError();
  try {
    const decipher = createDecipheriv("aes-256-gcm", assertRuntimeKey(key), encrypted.nonce);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(encrypted.tag);
    return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
  } catch (error) {
    if (error instanceof RuntimeContentLockedError) throw error;
    throw new RuntimeContentTamperedError();
  }
}

export function encodeJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

export function decodeJson(value: Buffer): unknown {
  return JSON.parse(value.toString("utf8")) as unknown;
}
