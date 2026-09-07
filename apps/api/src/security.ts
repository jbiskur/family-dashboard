import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { config } from "./config";

const key = createHash("sha256")
  .update(config.PATHWAYS_ENCRYPTION_KEY)
  .digest();
export function encryptPrivate(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, data, cipher.getAuthTag()]
    .map((v) => v.toString("base64"))
    .join(".");
}
export function decryptPrivate(value: string): string {
  const [iv, data, tag] = value.split(".").map((v) => Buffer.from(v, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(data!), decipher.final()]).toString(
    "utf8",
  );
}
export function semanticId(value: string): string {
  const h = createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 32)
    .split("");
  h[12] = "5";
  h[16] = ((parseInt(h[16]!, 16) & 3) | 8).toString(16);
  return `${h.slice(0, 8).join("")}-${h.slice(8, 12).join("")}-${h.slice(12, 16).join("")}-${h.slice(16, 20).join("")}-${h.slice(20).join("")}`;
}
