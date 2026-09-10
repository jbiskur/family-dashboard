import {
  type Command,
  DataCoreFetchCommand,
  EventListCommand,
  EventTypeListCommand,
  FlowcoreClient,
  FlowTypeListCommand,
  TenantInstanceFetchCommand,
} from "@flowcore/sdk";
import { config } from "./config";

export const eventStreams = [
  { flowType: "heima.access.0", eventType: "access.changed.0" },
  { flowType: "heima.household.0", eventType: "resource.changed.0" },
  { flowType: "heima.notifications.0", eventType: "notification.changed.0" },
  { flowType: "heima.household.0", eventType: "import.rows-staged.0" },
  { flowType: "heima.household.0", eventType: "import.commit-requested.0" },
] as const;

let client: FlowcoreClient | undefined;
const cacheMs = 15_000;
let checkedAt = 0;
let healthy = false;
let inFlight: Promise<boolean> | undefined;

// The SDK exposes typed request construction/parsing but no abort option on
// execute(). Own only this read-only transport so the entire probe is bounded.
async function readCommand<Input, Output>(
  command: Command<Input, Output>,
  signal: AbortSignal,
  eventSourceOrigin?: string,
): Promise<Output> {
  signal.throwIfAborted();
  client ??= new FlowcoreClient({
    apiKey: config.FLOWCORE_API_KEY,
    retry: null,
  });
  const request = await command.getRequest(client, true);
  if (request.method !== "GET") throw new Error("Readiness must be read-only");
  const authorization = await client.getAuthHeader();
  if (!authorization) throw new Error("Missing event credentials");
  const response = await fetch(
    `${eventSourceOrigin ?? request.baseUrl}${request.path}`,
    {
      method: "GET",
      headers: { ...request.headers, Authorization: authorization },
      signal,
      redirect: "error",
    },
  );
  if (!response.ok) throw new Error("Event fetch unavailable");
  const result = await request.parseResponse(await response.json());
  signal.throwIfAborted();
  return result;
}

async function probe(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const signal = controller.signal;
    const [core, tenant] = await Promise.all([
      readCommand(
        new DataCoreFetchCommand({
          tenant: config.FLOWCORE_TENANT,
          dataCore: config.FLOWCORE_DATA_CORE,
        }),
        signal,
      ),
      readCommand(
        new TenantInstanceFetchCommand({ tenant: config.FLOWCORE_TENANT }),
        signal,
      ),
    ]);
    const flowTypes = await readCommand(
      new FlowTypeListCommand({ dataCoreId: core.id }),
      signal,
    );
    let eventSourceOrigin: string | undefined;
    if (tenant.isDedicated) {
      if (!tenant.instance?.domain) throw new Error("Missing tenant routing");
      // Match Command.getDedicatedBaseUrl in the installed Flowcore SDK.
      eventSourceOrigin = `https://event-source.${tenant.instance.domain}`;
    }
    const timeBucket = `${new Date().toISOString().replace(/\D/g, "").slice(0, 10)}0000`;
    await Promise.all(
      eventStreams.map(async (stream) => {
        const flowType = flowTypes.find(
          (flow) => flow.name === stream.flowType,
        );
        if (!flowType) throw new Error("Missing event stream");
        const events = await readCommand(
          new EventTypeListCommand({ flowTypeId: flowType.id }),
          signal,
        );
        const eventType = events.find(
          (event) => event.name === stream.eventType,
        );
        if (!eventType) throw new Error("Missing event stream");
        // Empty events are valid. Discard payloads and cursors without processing
        // or persisting them; this probe never advances the real pump.
        await readCommand(
          new EventListCommand({
            tenant: config.FLOWCORE_TENANT,
            eventTypeId: eventType.id,
            timeBucket,
            pageSize: 1,
          }),
          signal,
          eventSourceOrigin,
        );
      }),
    );
    signal.throwIfAborted();
    return true;
  } catch {
    return false;
  } finally {
    controller.abort();
    clearTimeout(timeout);
  }
}

export async function eventFetchReady(): Promise<boolean> {
  // Test-mode delivery is the canonical encrypted webhook fixture, not a pump.
  if (config.NODE_ENV === "test") return true;
  if (checkedAt && Date.now() - checkedAt < cacheMs) return healthy;
  if (!inFlight) {
    healthy = false;
    inFlight = probe().then((result) => {
      healthy = result;
      checkedAt = Date.now();
      inFlight = undefined;
      return result;
    });
  }
  return inFlight;
}
