/** Reproduced against a minimal independent cached HTML/service worker, not an app-error catch. */
export function macWebKitOfflineNavigationUnsupported(browserName: string) {
  return process.platform === "darwin" && browserName === "webkit";
}
export const offlineNavigationLimitation =
  "macOS Playwright WebKit aborts offline navigation before its controlling service worker; independent static-SW control reproduces the internal error. In-page assertions run; Chromium/Firefox/mobile retain hard-reload proof, Linux WebKit remains enabled.";
