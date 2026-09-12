import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { loadTestEnv } from "../fixtures/auth";

test("OAuth migrations create clean storage, preserve populated upgrades and rerun safely", async () => {
  await loadTestEnv();
  const suffix = Date.now().toString();
  const database = postgres(process.env.DATABASE_URL ?? "", {
    max: 1,
    onnotice: () => {},
  });
  const journal = (await Bun.file(
    "apps/api/drizzle/meta/_journal.json",
  ).json()) as { entries: Array<{ tag: string; when: number }> };
  const migrate = async (schema: string) => {
    const child = Bun.spawn(["bun", "apps/api/src/db/migrate.ts"], {
      env: { ...process.env, NODE_ENV: "test", DATABASE_SCHEMA: schema },
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await child.exited).toBe(0);
  };
  try {
    for (const populated of [false, true]) {
      const schema = `heima_oauth_${populated ? "old" : "new"}_${suffix}`;
      await database`create schema ${database(schema)}`;
      const sql = postgres(process.env.DATABASE_URL ?? "", {
        max: 1,
        connection: { search_path: schema },
        onnotice: () => {},
      });
      const householdId = randomUUID(),
        sessionId = randomUUID(),
        userId = randomUUID();
      try {
        if (populated) {
          // A disposable pre-feature database fixture, not an application write path.
          await sql`create table __drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
          const featureIndex = journal.entries.findIndex(
            (entry) => entry.tag === "0006_oauth_agent_access",
          );
          expect(featureIndex).toBeGreaterThan(0);
          for (const entry of journal.entries.slice(0, featureIndex)) {
            const source = await Bun.file(
              `apps/api/drizzle/${entry.tag}.sql`,
            ).text();
            for (const statement of source.split("--> statement-breakpoint"))
              if (statement.trim()) await sql.unsafe(statement);
            await sql`insert into __drizzle_migrations (hash,created_at) values (${createHash("sha256").update(source).digest("hex")},${entry.when})`;
          }
          await sql`insert into households (id,name,created_at) values (${householdId},'Migration fixture',now())`;
          await sql`insert into auth_sessions (id,user_id,encrypted_tokens,expires_at) values (${sessionId},${userId},'synthetic-encrypted-custody',now()+interval '1 hour')`;
        }
        await migrate(schema);
        const names =
          await sql`select table_name from information_schema.tables where table_schema=${schema} and table_name like 'oauth_%' order by table_name`;
        expect(names.map((row) => row.table_name)).toEqual([
          "oauth_grants",
          "oauth_requests",
          "oauth_tokens",
        ]);
        const before =
          await sql`select hash,created_at from __drizzle_migrations order by id`;
        expect(before.length).toBe(journal.entries.length);
        await migrate(schema);
        expect(
          await sql`select hash,created_at from __drizzle_migrations order by id`,
        ).toEqual(before);
        if (populated) {
          expect(
            (await sql`select name from households where id=${householdId}`)[0]
              ?.name,
          ).toBe("Migration fixture");
          expect(
            (
              await sql`select encrypted_tokens from auth_sessions where id=${sessionId}`
            )[0]?.encrypted_tokens,
          ).toBe("synthetic-encrypted-custody");
        }
      } finally {
        await sql.end();
        await database`drop schema ${database(schema)} cascade`;
      }
    }
  } finally {
    await database.end();
  }
}, 30_000);
