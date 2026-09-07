import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import { type ApiVariables, accessRoutes, expireInvitations } from "./access";
import { verifyIdentity } from "./auth";
import { config } from "./config";
import { sqlClient } from "./db/client";
import { migrateDatabase } from "./db/migrate";
import { ApiFailure } from "./errors";
import { importRoutes } from "./imports";
import { notificationRoutes, processNotifications } from "./notifications";
import { pathways, runtimeReady, startRuntime, stopRuntime } from "./pathways";
import { resourceRoutes } from "./resources";

const app = new Hono<{ Variables: ApiVariables }>();
app.use("*", secureHeaders());
app.use("*", bodyLimit({ maxSize: 15 * 1024 * 1024 }));
app.use("/v1/*", async (c, next) => {
  c.header("cache-control", "no-store");
  c.set("identity", await verifyIdentity(c.req.header("authorization")));
  await next();
});
app.get("/health/live", (c) => c.json({ status: "ok" }));
app.get("/health/ready", (c) =>
  c.json(
    { status: runtimeReady ? "ready" : "starting" },
    runtimeReady ? 200 : 503,
  ),
);
app.route("/v1/access", accessRoutes);
app.route("/v1", notificationRoutes);
app.route("/v1", importRoutes);
app.route("/v1", resourceRoutes);
if (config.NODE_ENV === "test" && config.TEST_TRANSFORMER_SECRET)
  app.post("/__test/transformer", async (c) => {
    if (c.req.header("x-secret") !== config.TEST_TRANSFORMER_SECRET)
      return c.json({ error: "Unauthorized" }, 401);
    const event = await c.req.json();
    if (
      event.flowType === "heima.access.0" &&
      event.eventType === "access.changed.0"
    )
      await pathways.process("heima.access.0/access.changed.0", event);
    else if (
      event.flowType === "heima.household.0" &&
      event.eventType === "resource.changed.0"
    )
      await pathways.process("heima.household.0/resource.changed.0", event);
    else if (
      event.flowType === "heima.notifications.0" &&
      event.eventType === "notification.changed.0"
    )
      await pathways.process(
        "heima.notifications.0/notification.changed.0",
        event,
      );
    else return c.json({ error: "Unknown event" }, 400);
    return c.json({ success: true });
  });
app.onError((error, c) => {
  if (error instanceof ZodError || error instanceof SyntaxError)
    return c.json(
      {
        error: {
          code: "invalid-input",
          message: "Check the form and try again.",
        },
      },
      400,
    );
  if (error instanceof ApiFailure)
    return c.json(
      { error: { code: error.code, message: error.message } },
      error.status,
    );
  console.error("Request failed", { name: error.name });
  return c.json(
    {
      error: {
        code: "service-unavailable",
        message: "Something went wrong. Try again shortly.",
      },
    },
    503,
  );
});
await migrateDatabase();
const server = Bun.serve({
  port: config.PORT,
  hostname: "0.0.0.0",
  fetch: app.fetch,
  idleTimeout: 60,
});
await startRuntime();
console.log(`Heima API ready on port ${config.PORT}`);
const maintenance = setInterval(() => {
  void expireInvitations().catch(() =>
    console.error("Invitation expiry maintenance failed"),
  );
  void processNotifications().catch(() =>
    console.error("Notification maintenance failed"),
  );
}, 60_000);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    clearInterval(maintenance);
    server.stop();
    await stopRuntime();
    await sqlClient.end();
    process.exit(0);
  });
