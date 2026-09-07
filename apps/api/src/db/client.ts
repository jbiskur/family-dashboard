import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config";
import * as schema from "./schema";

export const sqlClient = postgres(config.DATABASE_URL, {
  max: 8,
  connection: { search_path: config.DATABASE_SCHEMA },
  onnotice: () => {},
});
export const db = drizzle(sqlClient, { schema });
export type Database = typeof db;
