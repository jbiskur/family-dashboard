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

export function startExistingReadinessFixture(
  initial: Mode = "empty",
  selected = 0,
) {
  const flows = [
    ...new Map(streams.map((stream) => [stream[0], stream])).values(),
  ];
  const flowIds = flows.map(() => crypto.randomUUID());
  const eventIds = streams.map(() => crypto.randomUUID());
  const coreName = "heima-readiness-fixture";
  const mode = initial;
  const receipts: Array<{
    eventId: string;
    timeBucket: string;
    method: string;
  }> = [];
  let writes = 0;
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
      // Local production-mode control-plane responses, never forwarded remotely.
      const host = url.searchParams.get("fixtureHost");
      const syntheticPathwayId = "e9bfae07-42aa-4798-befe-f2bbac0a1f6b";
      if (host === "data-pathways.api.flowcore.io") {
        if (
          request.method === "PUT" &&
          url.pathname === "/api/v1/pathways/by-name/heima-production"
        ) {
          const body = await request.json();
          if (
            body.tenant !== coreName ||
            body.dataCore !== coreName ||
            body.type !== "virtual" ||
            JSON.stringify(body.virtualConfig?.flowTypes) !==
              JSON.stringify(flows.map((stream) => stream[0]))
          )
            return json(
              { error: "Unexpected local pathway registration" },
              400,
            );
          return json({ pathwayId: syntheticPathwayId, status: "created" });
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/v1/pump-pulse"
        ) {
          const body = await request.json();
          if (body.pathwayId !== syntheticPathwayId)
            return json({ error: "Unexpected local pathway pulse" }, 400);
          return json({ status: "ok" });
        }
        if (
          request.method === "GET" &&
          url.pathname ===
            `/api/v1/pathways/${syntheticPathwayId}/commands/pending`
        )
          return json({ commands: [] });
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

  return { fixture, receipts, getUnexpectedWrites: () => writes };
}
