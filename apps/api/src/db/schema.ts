import type { ImportBatchEvent, ImportTransferHeader } from "@heima/contracts";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Application-owned projection of encrypted import events. No domain reader
// exposes staging; only the event handler may write it. No foreign keys.
export const importTransfers = pgTable("import_transfers", {
  commandId: uuid("command_id").primaryKey(),
  householdId: uuid("household_id").notNull(),
  actorId: uuid("actor_id").notNull(),
  header: jsonb("header").$type<ImportTransferHeader>().notNull(),
  parts: jsonb("parts")
    .$type<
      Record<string, Pick<ImportBatchEvent, "offset" | "partDigest" | "rows">>
    >()
    .notNull(),
  manifest: jsonb("manifest").$type<Record<string, unknown>>(),
  commitReceived: boolean("commit_received").notNull().default(false),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
});

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
// Transactional OAuth infrastructure; these records never grant household roles.
export const oauthRequests = pgTable(
  "oauth_requests",
  {
    id: uuid("id").primaryKey(),
    browserHash: text("browser_hash").notNull(),
    sessionId: text("session_id"),
    userId: uuid("user_id"),
    clientId: uuid("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    resource: text("resource").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    state: text("state").notNull(),
    challenge: text("challenge").notNull(),
    status: text("status").notNull().default("pending"),
    codeHash: text("code_hash").unique(),
    codeExpiresAt: timestamp("code_expires_at", { withTimezone: true }),
    codeConsumedAt: timestamp("code_consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("oauth_requests_expiry").on(table.expiresAt)],
);
export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: uuid("id").primaryKey(),
    requestId: uuid("request_id").notNull().unique(),
    userId: uuid("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    clientId: uuid("client_id").notNull(),
    resource: text("resource").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("oauth_grants_user").on(table.userId, table.createdAt)],
);
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: uuid("id").primaryKey(),
    grantId: uuid("grant_id").notNull(),
    accessHash: text("access_hash").notNull().unique(),
    refreshHash: text("refresh_hash").notNull().unique(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    accessExpiresAt: timestamp("access_expires_at", {
      withTimezone: true,
    }).notNull(),
    refreshExpiresAt: timestamp("refresh_expires_at", {
      withTimezone: true,
    }).notNull(),
    refreshUsedAt: timestamp("refresh_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("oauth_tokens_grant").on(table.grantId)],
);
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
