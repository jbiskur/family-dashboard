CREATE TABLE "import_transfers" (
  "command_id" uuid PRIMARY KEY NOT NULL,
  "household_id" uuid NOT NULL,
  "actor_id" uuid NOT NULL,
  "header" jsonb NOT NULL,
  "parts" jsonb NOT NULL,
  "manifest" jsonb,
  "commit_received" boolean DEFAULT false NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL
);
