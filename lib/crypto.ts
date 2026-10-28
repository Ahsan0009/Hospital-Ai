import "server-only";

import crypto from "node:crypto";

// Clinic WhatsApp tokens are encrypted here, before they reach the database,
// with CLINIC_SECRETS_KEY (64 hex characters = 32 bytes). The n8n server holds
// the same key to decrypt. A database leak alone does not reveal any token.

function key(): Buffer {
  const hex = process.env.CLINIC_SECRETS_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("CLINIC_SECRETS_KEY must be 64 hex characters.");
  return Buffer.from(hex, "hex");
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptSecret(sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("Unknown secret format.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function randomSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}
