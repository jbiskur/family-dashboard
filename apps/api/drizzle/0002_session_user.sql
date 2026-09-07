ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS user_id uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id, expires_at) WHERE user_id IS NOT NULL;
