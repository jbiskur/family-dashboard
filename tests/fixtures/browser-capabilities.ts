import { readFileSync } from "node:fs";

/** Only a fresh independent control receipt permits CI to omit hard navigation. */
export function webKitOfflineNavigationUnsupported(browserName: string) {
  if (browserName !== "webkit") return false;
  const reportPath = process.env.HEIMA_BROWSER_CAPABILITY_REPORT;
  // This local platform control was independently reproduced before adding CI probing.
  if (!reportPath) return process.platform === "darwin";
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (
    report.control !== "independent-static-service-worker-v1" ||
    report.platform !== process.platform ||
    report.browser !== "webkit" ||
    report.controlled !== true ||
    report.cached !== true ||
    !Number.isFinite(Date.parse(report.observedAt)) ||
    Math.abs(Date.now() - Date.parse(report.observedAt)) > 60 * 60 * 1000
  )
    throw new Error("Invalid or stale independent browser capability receipt");
  return (
    report.offlineNavigation === "unsupported" &&
    report.documentReplaced === false &&
    report.reloadError?.includes("WebKit encountered an internal error") ===
      true
  );
}
export const offlineNavigationLimitation =
  "Playwright WebKit aborts offline navigation before its controlling service worker; an independent static-SW control reproduces the internal error. In-page assertions run; Chromium/Firefox/mobile retain hard-reload proof. CI only omits this boundary when its own fresh control report reproduces the error.";
