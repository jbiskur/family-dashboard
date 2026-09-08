import {
  createPostgresPathwayCoordinator,
  createPostgresPathwayState,
  createPostgresPumpStateManagerFactory,
  PathwaysBuilder,
} from "@flowcore/pathways";
import {
  type AccessEvent,
  accessEventSchema,
  type NotificationEvent,
  notificationEventSchema,
  type ResourceEvent,
  resourceEventSchema,
} from "@heima/contracts";
import { eq } from "drizzle-orm";
import { projectAccess } from "./access-projection";
import { config } from "./config";
import { db } from "./db/client";
import { commands } from "./db/schema";
import { ApiFailure } from "./errors";
import { projectNotification } from "./notification-projection";
import { projectResource } from "./resource-projection";

export const pathways = new PathwaysBuilder({
  baseUrl: config.FLOWCORE_WEBHOOK_BASE_URL,
  tenant: config.FLOWCORE_TENANT,
  dataCore: config.FLOWCORE_DATA_CORE,
  apiKey: config.FLOWCORE_API_KEY,
  runtimeEnv: config.NODE_ENV,
  pathwayMode: "virtual",
  pathwayName: `heima-${config.NODE_ENV}`,
  autoProvision: {
    dataCore: true,
    flowType: true,
    eventType: true,
    pathway: true,
  },
  dataCoreDescription: "Private Heima household event history",
  dataCoreAccessControl: "private",
  dataCoreDeleteProtection: true,
  encryption: { mode: "symmetric", key: config.PATHWAYS_ENCRYPTION_KEY },
  pathwayTimeoutMs: 20_000,
})
  .register({
    flowType: "heima.access.0",
    eventType: "access.changed.0",
    schema: accessEventSchema,
    writable: true,
    encrypted: true,
    flowTypeDescription: "Private household admission and access",
    description: "An authorized household access change was requested",
  })
  .handle("heima.access.0/access.changed.0", projectAccess)
  .register({
    flowType: "heima.household.0",
    eventType: "resource.changed.0",
    schema: resourceEventSchema,
    writable: true,
    encrypted: true,
    flowTypeDescription: "Private shopping, work and financial household facts",
    description:
      "An authorized versioned household resource change was requested",
  })
  .handle("heima.household.0/resource.changed.0", projectResource)
  .register({
    flowType: "heima.notifications.0",
    eventType: "notification.changed.0",
    schema: notificationEventSchema,
    writable: true,
    encrypted: true,
    description: "Private recipient activity and notification delivery state",
  })
  .handle("heima.notifications.0/notification.changed.0", projectNotification)
  .withPathwayState(
    createPostgresPathwayState({
      connectionString: config.DATABASE_URL,
      statePrefix: config.DATABASE_SCHEMA,
      pool: { max: 3 },
      ttlMs: 86_400_000,
    }),
  );

export let runtimeReady = false;
export async function startRuntime() {
  if (config.NODE_ENV !== "test") {
    await pathways.provision();
    const coordinator = await createPostgresPathwayCoordinator(
      { connectionString: config.DATABASE_URL, pool: { max: 2 } },
      { statePrefix: config.DATABASE_SCHEMA },
    );
    await pathways.startCluster({
      coordinator,
      advertisedAddress: config.PATHWAYS_CLUSTER_ADVERTISED_ADDRESS,
      port: config.PATHWAYS_CLUSTER_PORT,
    });
    const stateManagerFactory = await createPostgresPumpStateManagerFactory({
      connectionString: config.DATABASE_URL,
      statePrefix: config.DATABASE_SCHEMA,
      pool: { max: 2 },
    });
    await pathways.startPump({
      stateManagerFactory,
      notifier: { type: "websocket" },
      autoProvision: false,
    });
  }
  runtimeReady = true;
}
export async function stopRuntime() {
  runtimeReady = false;
  await pathways.stopPump();
  await pathways.stopCluster();
}

export async function emitAccess(event: AccessEvent) {
  const previous = (
    await db
      .select()
      .from(commands)
      .where(eq(commands.id, event.commandId))
      .limit(1)
  )[0];
  if (previous && previous.actorId !== event.actorId)
    throw new ApiFailure(
      "command-conflict",
      409,
      "This change could not be applied. Refresh and try again.",
    );
  if (!previous) {
    try {
      await pathways.write("heima.access.0/access.changed.0", { data: event });
    } catch {
      throw new ApiFailure(
        "event-unavailable",
        503,
        "The change could not be confirmed. Refresh before trying again.",
      );
    }
  }
  const result =
    previous ??
    (
      await db
        .select()
        .from(commands)
        .where(eq(commands.id, event.commandId))
        .limit(1)
    )[0];
  if (!result)
    throw new ApiFailure(
      "processing-pending",
      503,
      "Your change is still being confirmed. Refresh before trying again.",
    );
  if (result.status === "rejected")
    throw new ApiFailure(
      result.errorCode ?? "command-conflict",
      409,
      "This change conflicts with the current household state. Refresh and try again.",
    );
}

export async function emitResource(event: ResourceEvent) {
  const previous = (
    await db
      .select()
      .from(commands)
      .where(eq(commands.id, event.commandId))
      .limit(1)
  )[0];
  if (previous && previous.actorId !== event.actorId)
    throw new ApiFailure(
      "command-conflict",
      409,
      "This change could not be applied. Refresh and try again.",
    );
  if (!previous) {
    try {
      await pathways.write("heima.household.0/resource.changed.0", {
        data: event,
      });
    } catch {
      throw new ApiFailure(
        "event-unavailable",
        503,
        "The change could not be confirmed. Refresh before trying again.",
      );
    }
  }
  const result =
    previous ??
    (
      await db
        .select()
        .from(commands)
        .where(eq(commands.id, event.commandId))
        .limit(1)
    )[0];
  if (!result)
    throw new ApiFailure(
      "processing-pending",
      503,
      "Your change is still being confirmed. Refresh before trying again.",
    );
  if (result.status === "rejected")
    throw new ApiFailure(
      result.errorCode ?? "command-conflict",
      result.errorCode === "not-found" ? 404 : 409,
      result.errorCode === "version-conflict"
        ? "Someone changed this item. Review the latest version before reapplying your change."
        : "This change could not be applied. Check the values and current state.",
    );
}

export async function emitNotification(event: NotificationEvent) {
  const previous = (
    await db
      .select()
      .from(commands)
      .where(eq(commands.id, event.commandId))
      .limit(1)
  )[0];
  if (
    previous &&
    (previous.actorId !== event.actorId ||
      previous.householdId !== event.householdId)
  )
    throw new ApiFailure(
      "command-conflict",
      409,
      "This change could not be applied.",
    );
  if (!previous) {
    try {
      await pathways.write("heima.notifications.0/notification.changed.0", {
        data: event,
      });
    } catch {
      throw new ApiFailure(
        "event-unavailable",
        503,
        "The change could not be confirmed. Try again when connected.",
      );
    }
    const confirmed = (
      await db
        .select()
        .from(commands)
        .where(eq(commands.id, event.commandId))
        .limit(1)
    )[0];
    if (!confirmed)
      throw new ApiFailure(
        "processing-pending",
        503,
        "The change is still being confirmed. Try again when connected.",
      );
  }
}
