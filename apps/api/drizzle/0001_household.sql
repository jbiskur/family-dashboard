CREATE TABLE IF NOT EXISTS resources (id uuid PRIMARY KEY, household_id uuid NOT NULL, kind text NOT NULL, owner_id uuid NOT NULL, visibility text NOT NULL, version integer NOT NULL, data jsonb NOT NULL, archived text NOT NULL DEFAULT 'false', source_event_id text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS resources_household_kind ON resources(household_id,kind);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS resource_history (id uuid PRIMARY KEY, household_id uuid NOT NULL, resource_id uuid NOT NULL, actor_id uuid NOT NULL, action text NOT NULL, before jsonb, after jsonb, occurred_at timestamptz NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS resource_history_resource ON resource_history(household_id,resource_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS activity (id uuid PRIMARY KEY, household_id uuid NOT NULL, recipient_id uuid NOT NULL, resource_id uuid NOT NULL, category text NOT NULL, title text NOT NULL, href text NOT NULL, is_read text NOT NULL DEFAULT 'false', push_state text NOT NULL DEFAULT 'pending', occurred_at timestamptz NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS activity_recipient ON activity(household_id,recipient_id,occurred_at);
