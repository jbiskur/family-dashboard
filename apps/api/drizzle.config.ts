import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  tablesFilter: [
    "households",
    "bootstrap_state",
    "members",
    "invitations",
    "commands",
    "auth_sessions",
    "oauth_requests",
    "oauth_grants",
    "oauth_tokens",
    "resources",
    "resource_history",
    "activity",
    "import_transfers",
  ],
});
