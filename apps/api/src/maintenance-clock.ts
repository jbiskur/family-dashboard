import { z } from "zod";
import { config } from "./config";

/** Scheduler clock only; provider tokens, request authentication and all other clocks remain real. */
export async function maintenanceNow(): Promise<Date> {
  if (config.NODE_ENV !== "test" || !config.TEST_MAINTENANCE_CLOCK_URL)
    return new Date();
  const response = await fetch(config.TEST_MAINTENANCE_CLOCK_URL, {
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Maintenance clock unavailable");
  const { now } = z
    .object({ now: z.string().datetime() })
    .strict()
    .parse(await response.json());
  return new Date(now);
}
