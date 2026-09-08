// External Flowcore transport fixture for an isolated development-mode process.
// Production code and its real HTTP readiness route remain unchanged.
const fixture = new URL(process.env.HEIMA_READINESS_FIXTURE ?? "");
if (
  process.env.NODE_ENV !== "development" ||
  !/^heima_readiness_[a-z0-9_]+$/.test(process.env.DATABASE_SCHEMA ?? "") ||
  fixture.protocol !== "http:" ||
  fixture.hostname !== "127.0.0.1"
)
  throw new Error("Readiness fixture requires an isolated local test process");

const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (!url.hostname.endsWith(".flowcore.io")) return nativeFetch(request);
  const destination = new URL(`${url.pathname}${url.search}`, fixture);
  destination.searchParams.set("fixtureHost", url.hostname);
  return nativeFetch(new Request(destination, request));
}) as typeof fetch;

const NativeWebSocket = globalThis.WebSocket;
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
