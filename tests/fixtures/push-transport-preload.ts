/** Test process only: redirect the push-service HTTP dependency, preserving web-push crypto. */
import http, { type RequestOptions } from "node:http";
import https from "node:https";

if (process.env.NODE_ENV !== "test")
  throw new Error("Push fixture preload is test-only");
const originalRequest = https.request;
https.request = ((...args: unknown[]) => {
  const options = args[0] as RequestOptions | undefined;
  if (
    options &&
    typeof options === "object" &&
    options.hostname === "fcm.googleapis.com" &&
    typeof options.path === "string" &&
    /^\/heima-test\/[0-9a-f-]{36}$/.test(options.path)
  ) {
    return Reflect.apply(http.request, http, [
      {
        ...options,
        protocol: "http:",
        hostname: "127.0.0.1",
        port: 3212,
        path: options.path.replace("/heima-test/", "/__push/"),
        agent: undefined,
      },
      ...args.slice(1),
    ]);
  }
  return Reflect.apply(originalRequest, https, args);
}) as typeof https.request;
// Speed only the timer cadence. Wall time, JWT expiry and quiet-hour decisions remain real.
const originalInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: unknown[]) => {
  if (args[1] === 60_000) args[1] = 500;
  return Reflect.apply(originalInterval, globalThis, args);
}) as typeof setInterval;
