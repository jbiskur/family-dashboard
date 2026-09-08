import {
  createECDH,
  createPublicKey,
  type ECDH,
  randomBytes,
  verify,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";

const apiRequire = createRequire(
  new URL("../../apps/api/package.json", import.meta.url),
);
const pushRequire = createRequire(apiRequire.resolve("web-push"));
const ece = pushRequire("http_ece");
type Subscription = { curve: ECDH; auth: string; status: number };
export class PushServiceFixture {
  private subscriptions = new Map<string, Subscription>();
  private captures: {
    id: string;
    status: number;
    payload: Record<string, unknown>;
    encryptedBytes: number;
    vapidValid: boolean;
    capturedAt: string;
  }[] = [];
  async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/__push")) return false;
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (url.pathname === "/__push-controls") {
      const body = JSON.parse(bytes.toString() || "{}");
      if (body.action === "create") {
        const id = crypto.randomUUID();
        const curve = createECDH("prime256v1");
        const key = curve.generateKeys().toString("base64url");
        const auth = randomBytes(16).toString("base64url");
        this.subscriptions.set(id, { curve, auth, status: 201 });
        send(201, {
          id,
          subscription: {
            endpoint: `https://fcm.googleapis.com/heima-test/${id}`,
            expirationTime: null,
            keys: { p256dh: key, auth },
          },
        });
      } else if (body.action === "status") {
        const subscription = this.subscriptions.get(body.id);
        if (!subscription) send(404, {});
        else {
          subscription.status = body.status;
          send(200, {});
        }
      } else if (body.action === "clear") {
        this.captures = [];
        send(200, {});
      } else if (body.action === "captures")
        send(200, {
          items: this.captures.filter((c) => !body.id || c.id === body.id),
        });
      else send(400, {});
      return true;
    }
    const id = url.pathname.slice("/__push/".length);
    const subscription = this.subscriptions.get(id);
    if (!subscription) {
      send(404, {});
      return true;
    }
    try {
      const authorization = request.headers.authorization ?? "";
      const token = /(?:^|[ ,])t=([^, ]+)/.exec(authorization)?.[1];
      const publicKey = /(?:^|[ ,])k=([^, ]+)/.exec(authorization)?.[1];
      if (!token || !publicKey) throw new Error("Missing VAPID proof");
      const [header, payload, signature] = token.split(".");
      const claims = JSON.parse(
        Buffer.from(payload ?? "", "base64url").toString(),
      );
      const key = createPublicKey({
        key: Buffer.concat([
          Buffer.from(
            "3059301306072a8648ce3d020106082a8648ce3d030107034200",
            "hex",
          ),
          Buffer.from(publicKey, "base64url"),
        ]),
        format: "der",
        type: "spki",
      });
      const vapidValid =
        claims.aud === "https://fcm.googleapis.com" &&
        claims.exp > Date.now() / 1000 &&
        publicKey === process.env.VAPID_PUBLIC_KEY &&
        verify(
          "sha256",
          Buffer.from(`${header}.${payload}`),
          { key, dsaEncoding: "ieee-p1363" },
          Buffer.from(signature ?? "", "base64url"),
        );
      if (!vapidValid) throw new Error("Invalid VAPID proof");
      const content = ece.decrypt(bytes, {
        version: "aes128gcm",
        privateKey: subscription.curve,
        authSecret: subscription.auth,
      });
      this.captures.push({
        id,
        status: subscription.status,
        payload: JSON.parse(content.toString()),
        encryptedBytes: bytes.length,
        vapidValid,
        capturedAt: new Date().toISOString(),
      });
      send(subscription.status, {});
    } catch {
      send(400, { error: "Push payload or VAPID proof invalid" });
    }
    return true;
  }
}
