// Isolated test process: shorten only the real maintenance timer interval, never wall time.
if (process.env.NODE_ENV !== "test")
  throw new Error("Scheduler fixture is test-only");
const original = globalThis.setInterval;
globalThis.setInterval = ((...args: unknown[]) => {
  if (args[1] === 60_000) args[1] = 200;
  return Reflect.apply(original, globalThis, args);
}) as typeof setInterval;
