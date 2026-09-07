CREATE TABLE IF NOT EXISTS households (id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS bootstrap_state (household_id uuid PRIMARY KEY, owner_id uuid NOT NULL, source_event_id text NOT NULL, created_at timestamptz NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS members (household_id uuid NOT NULL, user_id uuid NOT NULL, subject uuid NOT NULL, role text NOT NULL CHECK (role IN ('owner','spouse')), status text NOT NULL CHECK (status IN ('active','revoked')), source_event_id text NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY (household_id,user_id));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS members_active_role ON members (household_id, role) WHERE status = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS members_subject ON members (household_id, subject);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS invitations (id uuid PRIMARY KEY, household_id uuid NOT NULL, email_cipher text, status text NOT NULL, requested_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, source_event_id text NOT NULL, updated_at timestamptz NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS invitations_open_household ON invitations (household_id) WHERE status IN ('requesting','pending');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS commands (id uuid PRIMARY KEY, household_id uuid NOT NULL, actor_id uuid NOT NULL, status text NOT NULL, error_code text, result jsonb, source_event_id text NOT NULL, created_at timestamptz NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS auth_sessions (id text PRIMARY KEY, encrypted_tokens text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz DEFAULT now());
