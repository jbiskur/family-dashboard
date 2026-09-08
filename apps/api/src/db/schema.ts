import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const households = pgTable("households", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
export const bootstrapState = pgTable("bootstrap_state", {
  householdId: uuid("household_id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  sourceEventId: text("source_event_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
export const members = pgTable(
  "members",
  {
    householdId: uuid("household_id").notNull(),
    userId: uuid("user_id").notNull(),
    subject: uuid("subject").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.userId] })],
);
export const invitations = pgTable("invitations", {
  id: uuid("id").primaryKey(),
  householdId: uuid("household_id").notNull(),
  emailCipher: text("email_cipher"),
  status: text("status").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  sourceEventId: text("source_event_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
export const commands = pgTable("commands", {
  id: uuid("id").primaryKey(),
  householdId: uuid("household_id").notNull(),
  actorId: uuid("actor_id").notNull(),
  status: text("status").notNull(),
  errorCode: text("error_code"),
  result: jsonb("result").$type<Record<string, unknown>>(),
  sourceEventId: text("source_event_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
export const authSessions = pgTable("auth_sessions", {
  id: text("id").primaryKey(),
  userId: uuid("user_id"),
  encryptedTokens: text("encrypted_tokens").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
export const resources = pgTable("resources", {
  id: uuid("id").primaryKey(),
  householdId: uuid("household_id").notNull(),
  kind: text("kind").notNull(),
  ownerId: uuid("owner_id").notNull(),
  visibility: text("visibility").notNull(),
  version: integer("version").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  archived: text("archived").notNull().default("false"),
  sourceEventId: text("source_event_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
export const history = pgTable("resource_history", {
  id: uuid("id").primaryKey(),
  householdId: uuid("household_id").notNull(),
  resourceId: uuid("resource_id").notNull(),
  actorId: uuid("actor_id").notNull(),
  action: text("action").notNull(),
  before: jsonb("before").$type<Record<string, unknown>>(),
  after: jsonb("after").$type<Record<string, unknown>>(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
});
export const activity = pgTable("activity", {
  id: uuid("id").primaryKey(),
  householdId: uuid("household_id").notNull(),
  recipientId: uuid("recipient_id").notNull(),
  resourceId: uuid("resource_id"),
  category: text("category").notNull(),
  title: text("title").notNull(),
  href: text("href").notNull(),
  isRead: text("is_read").notNull().default("false"),
  pushState: text("push_state").notNull().default("pending"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
});
