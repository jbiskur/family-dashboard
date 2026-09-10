import { expect, test } from "bun:test";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";

type Mode = "empty" | "denied" | "missing" | "malformed" | "slow";
const tenantId = "9ae80348-25b1-4c97-a2eb-654fedc6b327";
const coreId = "0ba018a3-22c2-442f-bf16-578aefc05079";
const streams = [
  [
    "heima.access.0",
    "access.changed.0",
    "Private household admission and access",
    "An authorized household access change was requested",
  ],
  [
    "heima.household.0",
    "resource.changed.0",
    "Private shopping, work and financial household facts",
    "An authorized versioned household resource change was requested",
  ],
  [
    "heima.notifications.0",
    "notification.changed.0",
    "Private household activity and notification delivery",
    "Private recipient activity and notification delivery state",
  ],
  [
    "heima.household.0",
    "import.rows-staged.0",
    "Private shopping, work and financial household facts",
    "A bounded private statement row batch was staged",
  ],
  [
    "heima.household.0",
    "import.commit-requested.0",
    "Private shopping, work and financial household facts",
    "A complete private statement change was requested atomically",
  ],
] as const;

async function isolated(initial: Mode = "empty", selected = 0) {
  const env = { ...process.env };
  for (const line of (
    await Bun.file(process.env.HEIMA_TEST_ENV_FILE ?? ".env.test.local").text()
  ).split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  const flows = [
    ...new Map(streams.map((stream) => [stream[0], stream])).values(),
  ];
  const flowIds = flows.map(() => crypto.randomUUID());
  const eventIds = streams.map(() => crypto.randomUUID());
  const coreName = "heima-readiness-fixture";
  let mode = initial;
  const receipts: Array<{
    eventId: string;
    timeBucket: string;
    method: string;
  }> = [];
  let writes = 0;
  let log = "";
  const fixture = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    websocket: { message() {} },
    async fetch(request, server) {
      const url = new URL(request.url);
      const json = (body: unknown, status = 200) =>
        Response.json(body, { status });
      if (url.pathname === "/notifier") {
        if (server.upgrade(request)) return;
        return new Response(null, { status: 400 });
      }
      if (request.method !== "GET") {
        writes++;
        return json({ error: "Unexpected mutation" }, 405);
      }
      if (url.pathname.includes("/translate-name-to-id/"))
        return json({ id: tenantId, name: coreName });
      if (url.pathname.endsWith("/instance"))
        return json({ isDedicated: false, instance: null });
      if (url.pathname === "/api/v1/data-cores")
        return json([
          {
            id: coreId,
            tenantId,
            tenant: coreName,
            name: coreName,
            description: "Private Heima household event history",
            accessControl: "private",
            deleteProtection: true,
            isDeleting: false,
            isFlowcoreManaged: false,
            access: ["read", "ingest", "fetch"],
          },
        ]);
      if (url.pathname === "/api/v1/flow-types")
        return json(
          flows.map((stream, index) => ({
            id: flowIds[index],
            tenantId,
            dataCoreId: coreId,
            name: stream[0],
            description: stream[2],
            isDeleting: false,
          })),
        );
      if (url.pathname === "/api/v1/event-types") {
        const index = flowIds.indexOf(
          url.searchParams.get(
            "flowTypeId",
          ) as `${string}-${string}-${string}-${string}-${string}`,
        );
        if (index < 0) return json([], 404);
        return json(
          streams.flatMap((stream, eventIndex) =>
            stream[0] === flows[index][0]
              ? [
                  {
                    id: eventIds[eventIndex],
                    tenantId,
                    dataCoreId: coreId,
                    flowTypeId: flowIds[index],
                    name: stream[1],
                    description: stream[3],
                    isDeleting: false,
                    isTruncating: false,
                    createdAt: new Date().toISOString(),
                    updatedAt: null,
                  },
                ]
              : [],
          ),
        );
      }
      if (url.pathname === "/api/v1/events") {
        // The real pump uses its normal page size; observe only the bounded
        // readiness requests here, without recording credentials or payloads.
        const isProbe = url.searchParams.get("pageSize") === "1";
        const eventId = url.searchParams.get("eventTypeId") ?? "";
        if (isProbe) {
          receipts.push({
            eventId,
            timeBucket: url.searchParams.get("timeBucket") ?? "",
            method: request.method,
          });
          if (eventId === eventIds[selected]) {
            if (mode === "denied") return json({ error: "Forbidden" }, 403);
            if (mode === "missing")
              return json({ error: "Event type not found" }, 404);
            if (mode === "malformed")
              return json({
                events: "private-payload-marker",
                nextCursor: "private-cursor-marker",
              });
            if (mode === "slow") await Bun.sleep(6500);
          }
        }
        return json({ events: [] });
      }
      if (url.pathname === "/api/v1/time-buckets")
        return json({ timeBuckets: [] });
      return json({ error: "Unexpected fixture read" }, 404);
    },
  });
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  const clusterReservation = Bun.serve({
    port: 0,
    fetch: () => new Response(),
  });
  const clusterPort = clusterReservation.port;
  clusterReservation.stop(true);
  const runtime = Bun.spawn(
    [
      "bun",
      "--preload",
      "./tests/fixtures/readiness-preload.ts",
      "./apps/api/src/index.ts",
    ],
    {
      env: {
        ...env,
        NODE_ENV: "development",
        PORT: String(port),
        DATABASE_SCHEMA: `heima_readiness_${Date.now()}`,
        FLOWCORE_API_KEY: "fc_heimaReadinessFixture_notARealCredential",
        FLOWCORE_TENANT: coreName,
        FLOWCORE_DATA_CORE: coreName,
        FLOWCORE_WEBHOOK_BASE_URL: "https://webhook.api.flowcore.io",
        PATHWAYS_CLUSTER_PORT: String(clusterPort),
        PATHWAYS_CLUSTER_ADVERTISED_ADDRESS: "127.0.0.1",
        USABLE_API_BASE_URL: "https://usable.dev",
        USABLE_OIDC_ISSUER: "https://auth.flowcore.io/realms/memory-mesh",
        TEST_MAINTENANCE_CLOCK_URL: undefined,
        HEIMA_READINESS_FIXTURE: `http://127.0.0.1:${fixture.port}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) log += new TextDecoder().decode(chunk);
  };
  const logs = Promise.all([capture(runtime.stdout), capture(runtime.stderr)]);
  const origin = `http://127.0.0.1:${port}`;
  const stop = async () => {
    runtime.kill("SIGTERM");
    await Promise.race([runtime.exited, Bun.sleep(3000)]);
    if (runtime.exitCode === null) runtime.kill("SIGKILL");
    await runtime.exited;
    await logs;
    fixture.stop(true);
    expect(log).not.toContain("private-payload-marker");
    expect(log).not.toContain("private-cursor-marker");
    expect(log).not.toContain("fc_heimaReadinessFixture_notARealCredential");
    expect(writes).toBe(0);
  };
  const deadline = Date.now() + 15000;
  while (!log.includes(`Heima API ready on port ${port}`)) {
    if (Date.now() > deadline || runtime.exitCode !== null) {
      await stop();
      throw new Error("Isolated readiness API failed to start");
    }
    await Bun.sleep(40);
  }
  return {
    clusterPort,
    origin,
    receipts,
    eventIds,
    setMode: (value: Mode) => {
      mode = value;
    },
    stop,
  };
}

test("R1 empty streams are ready and concurrent probes share one bounded refresh", async () => {
  const fixture = await isolated();
  try {
    expect((await fetch(`${fixture.origin}/health/live`)).status).toBe(200);
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => fetch(`${fixture.origin}/health/ready`)),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ status: "ready" });
    }
    expect(fixture.receipts).toHaveLength(streams.length);
    expect(new Set(fixture.receipts.map((receipt) => receipt.eventId))).toEqual(
      new Set(fixture.eventIds),
    );
    for (const receipt of fixture.receipts) {
      expect(receipt.method).toBe("GET");
      expect(receipt.timeBucket).toMatch(/^\d{10}0000$/);
    }
  } finally {
    await fixture.stop();
  }
}, 30000);

for (let index = 0; index < streams.length; index++)
  test(`R2 stream ${index + 1} fetch denial makes readiness503 while liveness200`, async () => {
    const fixture = await isolated("denied", index);
    try {
      const response = await fetch(`${fixture.origin}/health/ready`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "starting" });
      expect((await fetch(`${fixture.origin}/health/live`)).status).toBe(200);
      expect(
        fixture.receipts.some(
          (receipt) => receipt.eventId === fixture.eventIds[index],
        ),
      ).toBe(true);
    } finally {
      await fixture.stop();
    }
  }, 30000);

for (const mode of ["missing", "malformed"] as const)
  test(`R3 ${mode} event response cannot pass readiness`, async () => {
    const fixture = await isolated(mode);
    try {
      const response = await fetch(`${fixture.origin}/health/ready`);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('{"status":"starting"}');
    } finally {
      await fixture.stop();
    }
  }, 30000);

test("R4 deadline aborts a stalled fetch, late success stays unready, and a later refresh recovers", async () => {
  const fixture = await isolated("slow");
  try {
    const start = Date.now();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => fetch(`${fixture.origin}/health/ready`)),
    );
    expect(Date.now() - start).toBeLessThan(6000);
    for (const response of responses) expect(response.status).toBe(503);
    expect(fixture.receipts).toHaveLength(streams.length);
    await Bun.sleep(2000);
    expect((await fetch(`${fixture.origin}/health/ready`)).status).toBe(503);
    fixture.setMode("empty");
    await Bun.sleep(13200);
    expect((await fetch(`${fixture.origin}/health/ready`)).status).toBe(200);
    expect(fixture.receipts).toHaveLength(streams.length * 2);
    fixture.setMode("denied");
    await Bun.sleep(15200);
    expect((await fetch(`${fixture.origin}/health/ready`)).status).toBe(503);
  } finally {
    await fixture.stop();
  }
}, 60000);

test("R5 running API cluster accepts loopback WebSocket and refuses non-loopback TCP", async () => {
  const external = Object.values(networkInterfaces())
    .flat()
    .find((address) => address?.family === "IPv4" && !address.internal);
  expect(external).toBeDefined();
  const fixture = await isolated();
  const port = fixture.clusterPort;
  const sockets: WebSocket[] = [];
  try {
    expect((await fetch(`${fixture.origin}/health/ready`)).status).toBe(200);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      sockets.push(socket);
      socket.onopen = () => socket.send(JSON.stringify({ type: "ping" }));
      socket.onmessage = (event) => resolve(String(event.data));
      socket.onerror = () =>
        reject(new Error("Loopback cluster connection failed"));
    });
    expect(JSON.parse(response)).toEqual({ type: "pong" });
    const externalResult = await new Promise<string>((resolve) => {
      const socket = connect({ host: external?.address, port });
      socket.once("connect", () => {
        socket.destroy();
        resolve("accepted");
      });
      socket.once("error", (error: NodeJS.ErrnoException) =>
        resolve(error.code ?? "unknown"),
      );
      socket.setTimeout(2_000, () => {
        socket.destroy();
        resolve("timeout");
      });
    });
    expect(externalResult).toBe("ECONNREFUSED");
  } finally {
    for (const socket of sockets) socket.close();
    await fixture.stop();
  }
}, 30000);
