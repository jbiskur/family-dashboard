import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config } from "../config";

export async function migrateDatabase() {
  const client = postgres(config.DATABASE_URL, {
    max: 1,
    connection: { search_path: config.DATABASE_SCHEMA },
    onnotice: () => {},
  });
  try {
    await client`CREATE SCHEMA IF NOT EXISTS ${client(config.DATABASE_SCHEMA)}`;
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(
        new URL("../../drizzle", import.meta.url),
      ),
      migrationsSchema: config.DATABASE_SCHEMA,
    });
  } finally {
    await client.end();
  }
}
if (import.meta.main) {
  await migrateDatabase();
  console.log("Application migrations complete");
}
