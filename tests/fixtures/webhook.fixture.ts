/**
 * Vendored from @usable/core/testing/webhook-fixture.
 * Canonical Usable fragment: f21efd04-8073-4f14-8dab-3d5271461634.
 * Harness reference: 76416405-d3ee-4e7b-99e4-f54eb978604b.
 *
 * This dependency-boundary fixture receives real Pathways HTTP writes and
 * delivers Flowcore envelopes to Heima's real registered handlers over HTTP.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { TimeUuid } from "@flowcore/time-uuid";

export type FlowcoreEnvelope = {
  dataCoreId: string;
  eventId: string;
  eventType: string;
  flowType: string;
  metadata: Record<string, string>;
  payload: unknown;
  tenant: string;
  timeBucket: string;
  validTime: string;
};

export type CapturedCall = {
  envelope: FlowcoreEnvelope;
  capturedAt: string;
  eventId: string;
  payload: unknown;
  metadata?: Record<string, string>;
  requestBytes: number;
  eventTimes?: { eventTime?: string; validTime?: string };
};

export type WebhookFixtureOptions = {
  dataCore: string;
  port: number;
  secret: string;
  tenant: string;
  transformerUrl: string;
  handleExternal?: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<boolean>;
};

export class WebhookTestFixture {
  private server?: Server;
  private readonly calls = new Map<string, CapturedCall[]>();
  private readonly forwarding = new Map<string, boolean>();
  private inboundStatus = 200;
  private inboundStatuses: number[] = [];
  private held = false;
  private releaseHeld?: () => void;

  constructor(private readonly options: WebhookFixtureOptions) {}

  addEndpoint(
    flowType: string,
    eventType: string,
    options: { forward?: boolean } = {},
  ) {
    const key = `${flowType}/${eventType}`;
    this.calls.set(key, []);
    this.forwarding.set(key, options.forward ?? true);
    return this;
  }

  getCalls(flowType: string, eventType: string) {
    return [...(this.calls.get(`${flowType}/${eventType}`) ?? [])];
  }

  getEventLog() {
    return [...this.calls.values()]
      .flat()
      .map(({ envelope }) => structuredClone(envelope))
      .sort((left, right) =>
        left.eventId === right.eventId
          ? `${left.flowType}/${left.eventType}`.localeCompare(
              `${right.flowType}/${right.eventType}`,
            )
          : left.eventId.localeCompare(right.eventId),
      );
  }

  recordEvent(envelope: FlowcoreEnvelope) {
    const key = `${envelope.flowType}/${envelope.eventType}`;
    const calls = this.calls.get(key);
    if (!calls) throw new Error(`endpoint not registered: ${key}`);
    if (calls.some((call) => call.eventId === envelope.eventId)) return;
    calls.push({
      capturedAt: new Date().toISOString(),
      envelope: structuredClone(envelope),
      eventId: envelope.eventId,
      payload: structuredClone(envelope.payload),
      requestBytes: Buffer.byteLength(JSON.stringify(envelope.payload)),
    });
  }

  setInboundStatus(status: number) {
    this.inboundStatus = status;
    this.inboundStatuses = [];
  }

  setInboundStatuses(statuses: number[]) {
    this.inboundStatuses = [...statuses];
  }

  holdWrites() {
    this.held = true;
  }

  releaseWrites() {
    this.held = false;
    this.releaseHeld?.();
    this.releaseHeld = undefined;
  }

  async start() {
    await this.stop();
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error) =>
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.options.port, "127.0.0.1", resolve);
    });
  }

  async stop() {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  async deliverEvent(envelope: FlowcoreEnvelope) {
    return fetch(this.options.transformerUrl, {
      body: JSON.stringify(envelope),
      headers: {
        "content-type": "application/json",
        "x-secret": this.options.secret,
      },
      method: "POST",
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    if (await this.options.handleExternal?.(request, response)) return;
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/__health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    const [, tenant, dataCore, flowType, eventType] = parts;
    const key = `${flowType}/${eventType}`;
    if (
      request.method !== "POST" ||
      parts[0] !== "event" ||
      parts.length !== 5 ||
      tenant !== this.options.tenant ||
      dataCore !== this.options.dataCore ||
      !this.calls.has(key)
    ) {
      sendJson(response, 404, { error: "endpoint not registered" });
      return;
    }
    const eventTime = header(request, "x-flowcore-event-time");
    const suppliedValidTime = header(request, "x-flowcore-valid-time");
    const validTime = suppliedValidTime ?? new Date().toISOString();
    const { payload, requestBytes } = await readJson(request);
    if (this.held)
      await new Promise<void>((resolve) => {
        this.releaseHeld = resolve;
      });
    const inboundStatus = this.inboundStatuses.shift() ?? this.inboundStatus;
    if (inboundStatus !== 200) {
      sendJson(response, inboundStatus, {
        error: "dependency unavailable",
      });
      return;
    }
    const capturedMetadata = metadata(request);
    const envelope: FlowcoreEnvelope = {
      dataCoreId: dataCore,
      eventId: TimeUuid.fromDate(new Date(validTime)).toString(),
      eventType,
      flowType,
      metadata: capturedMetadata,
      payload,
      tenant,
      timeBucket: timeBucketOf(validTime),
      validTime,
    };
    if (this.forwarding.get(key)) {
      const delivery = await this.deliverEvent(envelope);
      if (![200, 201].includes(delivery.status)) {
        sendJson(response, 502, {
          error: `transformer returned ${delivery.status}`,
        });
        return;
      }
    }
    this.calls.get(key)?.push({
      capturedAt: new Date().toISOString(),
      envelope,
      eventId: envelope.eventId,
      payload,
      requestBytes,
      ...(Object.keys(capturedMetadata).length > 0
        ? { metadata: capturedMetadata }
        : {}),
      ...(eventTime || suppliedValidTime
        ? {
            eventTimes: {
              ...(eventTime ? { eventTime } : {}),
              ...(suppliedValidTime ? { validTime: suppliedValidTime } : {}),
            },
          }
        : {}),
    });
    sendJson(response, 200, { eventId: envelope.eventId });
  }
}

function header(request: IncomingMessage, name: string) {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function metadata(request: IncomingMessage): Record<string, string> {
  const value = header(request, "x-flowcore-metadata-json");
  if (!value) return {};
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  const raw = body.toString("utf8");
  const requestLine = `${request.method ?? "POST"} ${request.url ?? "/"} HTTP/${request.httpVersion}\r\n`;
  const headers = `${request.rawHeaders
    .reduce<string[]>((lines, value, index, values) => {
      if (index % 2 === 0)
        lines.push(`${value}: ${values[index + 1] ?? ""}\r\n`);
      return lines;
    }, [])
    .join("")}\r\n`;
  return {
    payload: raw ? JSON.parse(raw) : {},
    requestBytes:
      Buffer.byteLength(requestLine) + Buffer.byteLength(headers) + body.length,
  };
}

function timeBucketOf(value: string) {
  const date = new Date(value);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}${String(date.getUTCHours()).padStart(2, "0")}0000`;
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
