ALTER TABLE members DROP CONSTRAINT members_role_check;
--> statement-breakpoint
ALTER TABLE members ADD CONSTRAINT members_role_check CHECK (role IN ('owner', 'spouse', 'admin'));
--> statement-breakpoint
DROP INDEX members_active_role;
--> statement-breakpoint
CREATE UNIQUE INDEX members_active_role ON members (household_id, role) WHERE status = 'active' AND role IN ('owner', 'spouse');
