-- Operational delegated-session state. Household authorization remains event sourced.
CREATE TABLE oauth_requests (
  id uuid PRIMARY KEY, browser_hash text NOT NULL, session_id text, user_id uuid,
  client_id uuid NOT NULL, redirect_uri text NOT NULL, resource text NOT NULL,
  scopes jsonb NOT NULL, state text NOT NULL, challenge text NOT NULL,
  status text NOT NULL DEFAULT 'pending', code_hash text UNIQUE,
  code_expires_at timestamptz, code_consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX oauth_requests_expiry ON oauth_requests (expires_at);
--> statement-breakpoint
CREATE TABLE oauth_grants (
  id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL, session_id text NOT NULL, client_id uuid NOT NULL,
  resource text NOT NULL, scopes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
--> statement-breakpoint
CREATE INDEX oauth_grants_user ON oauth_grants (user_id, created_at);
--> statement-breakpoint
CREATE TABLE oauth_tokens (
  id uuid PRIMARY KEY, grant_id uuid NOT NULL,
  access_hash text NOT NULL UNIQUE, refresh_hash text NOT NULL UNIQUE,
  scopes jsonb NOT NULL, access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL, refresh_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id);
