import {
  boolean,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { config } from "../config";

// Read-only documentation of @flowcore/pathways 2.7.0 runtime-owned tables.
// Deliberately excluded from drizzle.config.ts schema and application migrations.
// Pathways owns initialization, cursor writes, leases and upgrades in public.
const prefix = config.DATABASE_SCHEMA.replace(/_+$/, "");
export const pathwayState = pgTable(`${prefix}_pathway_state`, {
  eventId: text("event_id").primaryKey(),
  processed: boolean("processed").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export const pathwayLeases = pgTable(`${prefix}_pathway_leases`, {
  key: text("key").primaryKey(),
  instanceId: text("instance_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export const pathwayInstances = pgTable(`${prefix}_pathway_instances`, {
  instanceId: text("instance_id").primaryKey(),
  address: text("address").notNull(),
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const pathwayPumpState = pgTable(
  `${prefix}_pathway_pump_state`,
  {
    flowType: text("flow_type").notNull(),
    pumpGroup: text("pump_group").notNull().default("default"),
    timeBucket: text("time_bucket").notNull(),
    eventId: text("event_id"),
  },
  (t) => [primaryKey({ columns: [t.flowType, t.pumpGroup] })],
);
