// External socket observation adapted from existing readiness.test.ts R5.
// Run via docker exec against ONLY the owned local exact-image API container.
import { connect } from "node:net";
import { networkInterfaces } from "node:os";

const external = Object.values(networkInterfaces())
  .flat()
  .find((address) => address?.family === "IPv4" && !address.internal);
if (!external) throw new Error("No non-loopback IPv4 observation target");
const live = await fetch("http://127.0.0.1:3211/health/live", {
  signal: AbortSignal.timeout(5000),
});
const ready = await fetch("http://127.0.0.1:3211/health/ready", {
  signal: AbortSignal.timeout(6000),
});
await live.body?.cancel();
await ready.body?.cancel();
let socket: WebSocket | undefined;
let loopback: unknown;
try {
  loopback = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      socket?.close();
      reject(new Error("Loopback deadline"));
    }, 2000);
    socket = new WebSocket("ws://127.0.0.1:9091");
    socket.onopen = () => socket?.send(JSON.stringify({ type: "ping" }));
    socket.onmessage = (event) => {
      clearTimeout(deadline);
      try {
        resolve(JSON.parse(String(event.data)));
      } catch {
        reject(new Error("Invalid loopback response"));
      }
    };
    socket.onerror = () => {
      clearTimeout(deadline);
      reject(new Error("Loopback socket failed"));
    };
  });
} finally {
  socket?.close();
}
const nonLoopback = await new Promise<string>((resolve) => {
  const socket = connect({ host: external.address, port: 9091 });
  socket.once("connect", () => {
    socket.destroy();
    resolve("accepted");
  });
  socket.once("error", (error: NodeJS.ErrnoException) =>
    resolve(error.code ?? "unknown"),
  );
  socket.setTimeout(2000, () => {
    socket.destroy();
    resolve("timeout");
  });
});
const passed =
  live.status === 200 &&
  ready.status === 200 &&
  JSON.stringify(loopback) === '{"type":"pong"}' &&
  nonLoopback === "ECONNREFUSED";
console.log(
  JSON.stringify({
    observedAt: new Date().toISOString(),
    scope:
      "Local exact released image; production mode; isolated dependency fixture, not production-pod measurement",
    live: live.status,
    ready: ready.status,
    loopback,
    nonLoopback: { address: external.address, port: 9091, result: nonLoopback },
    passed,
  }),
);
if (!passed) process.exitCode = 1;
