// PREPARED TEST-ONLY ADAPTER. Never included in the image or repository runtime.

import { writeFileSync } from "node:fs";
import { startExistingReadinessFixture } from "./readiness-fixture-adapted.ts";

const dummyKey = "fc_heimaReadinessFixture_notARealCredential";
const database = new URL(process.env.DATABASE_URL ?? "");
if (
  process.env.HEIMA_LOCAL_SOCKET_PROOF !== "isolated-local-database-v022" ||
  process.env.NODE_ENV !== "production" ||
  process.env.DATABASE_SCHEMA !== "heima_prod" ||
  database.protocol !== "postgres:" ||
  database.hostname !== "heima-socket-db" ||
  database.port !== "5432" ||
  database.pathname !== "/heima_socket_v022" ||
  database.username !== "heima_socket" ||
  database.search ||
  database.hash ||
  process.env.FLOWCORE_API_KEY !== dummyKey ||
  process.env.FLOWCORE_TENANT !== "heima-readiness-fixture" ||
  process.env.FLOWCORE_DATA_CORE !== "heima-readiness-fixture" ||
  process.env.PATHWAYS_CLUSTER_ADVERTISED_ADDRESS !== "127.0.0.1" ||
  process.env.PATHWAYS_CLUSTER_PORT !== "9091" ||
  process.env.PORT !== "3211"
)
  throw new Error("Local exact-image socket proof isolation fence failed");

// The container and this exact dedicated database must be on an internal-only
// Docker network, inspected before execution; no published ports or live key.
const existing = startExistingReadinessFixture();
const fixture = new URL(`http://127.0.0.1:${existing.fixture.port}`);
const nativeFetch = globalThis.fetch;
const NativeWebSocket = globalThis.WebSocket;
const observed: Array<{ host: string; path: string; method: string }> = [];
const save = () =>
  writeFileSync(
    "/tmp/local-socket-fixture-receipt.json",
    JSON.stringify(
      {
        mode: "production application; isolated local dependency fixture",
        databaseHost: database.hostname,
        databaseName: database.pathname.slice(1),
        schema: "heima_prod",
        observed,
        readinessReads: existing.receipts,
        unexpectedWrites: existing.getUnexpectedWrites(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
globalThis.fetch = (async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (!url.hostname.endsWith(".flowcore.io")) return nativeFetch(request);
  const destination = new URL(`${url.pathname}${url.search}`, fixture);
  destination.searchParams.set("fixtureHost", url.hostname);
  observed.push({
    host: url.hostname,
    path: url.pathname,
    method: request.method,
  });
  const result = await nativeFetch(new Request(destination, request));
  save();
  return result;
}) as typeof fetch;
globalThis.WebSocket = class extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    const target = new URL(url);
    super(
      target.hostname.endsWith(".flowcore.io")
        ? `ws://${fixture.host}/notifier`
        : url,
      protocols,
    );
  }
} as typeof WebSocket;
save();
