import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test } from "@playwright/test";
import {
  offlineNavigationLimitation,
  webKitOfflineNavigationUnsupported,
} from "../fixtures/browser-capabilities";

const env = Object.fromEntries(
  readFileSync(".env.test.local", "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]),
);
test.use({ trace: "off", video: "off" });
test("Reduced motion and 200-percent equivalent layout retain usable navigation", async ({
  browser,
  browserName,
}, info) => {
  test.setTimeout(120_000);
  // 640 CSS pixels at 2× density reproduces a 1280-pixel viewport at 200% page zoom.
  const context = await browser.newContext({
    baseURL: "http://localhost:3010",
    viewport: { width: 640, height: 450 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Continue with Usable" }).click();
    await page.locator("#username").fill("owner@heima.test");
    if (!env.TEST_USER_PASSWORD)
      throw new Error("Missing local fixture password");
    await page.locator("#password").fill(env.TEST_USER_PASSWORD);
    await page.locator("#kc-login").click();
    await expect(page).toHaveURL("http://localhost:3010/");
    for (const path of [
      "/",
      "/shopping",
      "/work",
      "/finance",
      "/finance/accounts",
      "/finance/transactions",
      "/finance/spending",
      "/finance/budgets",
      "/finance/imports",
    ]) {
      await page.goto(path);
      await expect(page.locator(".loading-state")).toHaveCount(0);
      expect(
        await page.evaluate(
          () => matchMedia("(prefers-reduced-motion: reduce)").matches,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => getComputedStyle(document.documentElement).scrollBehavior,
        ),
      ).toBe("auto");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const activeAnimations = await page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState === "running" &&
                Number(animation.effect?.getComputedTiming().duration ?? 0) > 0,
            ).length,
      );
      expect(activeAnimations).toBe(0);
      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(
        axe.violations.map(({ id, nodes }) => ({
          id,
          targets: nodes.map((node) => node.target),
        })),
      ).toEqual([]);
    }
    await page.goto("/work");
    await page
      .getByRole("button", { name: "Add a to-do", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((animation) => animation.playState === "running").length,
      ),
    ).toBe(0);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Add a to-do", exact: true }),
    ).toBeFocused();
    await page.screenshot({
      path: info.outputPath("shell-200-percent-equivalent-reduced-motion.png"),
      fullPage: false,
    });
    await page.goto("/finance");
    await expect(page.locator(".loading-state")).toHaveCount(0);
    await page.evaluate(() => navigator.serviceWorker.ready);
    const privatePaths = await page.evaluate(async () => {
      const result: string[] = [];
      for (const name of await caches.keys())
        if (name.startsWith("heima-private"))
          for (const request of await (await caches.open(name)).keys())
            result.push(new URL(request.url).pathname);
      return result;
    });
    expect(privatePaths.some((path) => path.startsWith("/finance"))).toBe(
      false,
    );
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).some(
          (key) =>
            key.startsWith("heima-offline-data:") && key.includes("finance"),
        ),
      ),
    ).toBe(false);
    await context.setOffline(true);
    if (webKitOfflineNavigationUnsupported(browserName))
      info.annotations.push({
        type: "engine limitation",
        description: offlineNavigationLimitation,
      });
    else await page.reload();
    await expect(page.locator("body")).toContainText(
      /Finance needs a connection|You're offline/,
    );
    await expect(page.locator(".metric-grid")).toHaveCount(0);
    await expect(
      page.getByText("Household balance", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("Net cash flow", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.locator("body")).toContainText(
      /isn't saved on this device for offline use|isn't stored offline/,
    );
    await page.screenshot({
      path: info.outputPath("finance-offline-safe-shell.png"),
      fullPage: false,
    });
  } finally {
    await context.setOffline(false);
    await context.close();
  }
});

test("Browser parses the installable named manifest and real icon sizes", async ({
  page,
  context,
  browserName,
}, info) => {
  test.skip(
    browserName !== "chromium",
    "CDP installability inspection requires Chromium; navigation and offline behavior run on every browser.",
  );
  await page.goto("/");
  const cdp = await context.newCDPSession(page);
  const app = await cdp.send("Page.getAppManifest");
  expect(app.errors).toEqual([]);
  const manifest = JSON.parse(app.data ?? "{}");
  expect(manifest.name).toBe("Heima Family Dashboard");
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(
      (entry: { sizes: string; type: string }) =>
        entry.sizes === `${size}x${size}` && entry.type === "image/png",
    );
    expect(icon).toBeTruthy();
    const dimensions = await page.evaluate(async (src: string) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    }, icon.src);
    expect(dimensions).toEqual([size, size]);
  }
  const result = await cdp.send("Page.getInstallabilityErrors");
  await info.attach("browser-installability", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  expect(
    result.installabilityErrors.filter(
      (error: { errorId: string }) => error.errorId !== "in-incognito",
    ),
  ).toEqual([]);
});

test("Heima installs and launches in a standalone app window", async ({
  browserName,
}, info) => {
  test.skip(
    browserName !== "chromium" || info.project.name !== "chromium",
    "Desktop installation uses full Chromium CDP and an isolated disposable profile.",
  );
  const profile = await mkdtemp(join(tmpdir(), "heima-pwa-proof-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: "chromium",
    viewport: { width: 1000, height: 800 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  const manifestId = "http://localhost:3010/";
  let installed = false;
  try {
    await page.goto(manifestId);
    expect((await cdp.send("Page.getAppManifest")).errors).toEqual([]);
    await cdp.send("PWA.install", {
      manifestId,
      installUrlOrBundleUrl: manifestId,
    });
    installed = true;
    // Match the user's explicit browser choice to open the installed app in its own window.
    await cdp.send("PWA.changeAppUserSettings", {
      manifestId,
      displayMode: "standalone",
    });
    const opened = context.waitForEvent("page");
    const launch = await cdp.send("PWA.launch", { manifestId });
    expect(launch.targetId).toBeTruthy();
    const app = await opened;
    await expect(app).toHaveURL(manifestId);
    await expect
      .poll(() =>
        app.evaluate(() => matchMedia("(display-mode: standalone)").matches),
      )
      .toBe(true);
    await expect(
      app.getByRole("button", { name: "Continue with Usable" }),
    ).toBeVisible();
    await app.screenshot({
      path: info.outputPath("installed-standalone-login.png"),
    });
  } finally {
    if (installed) await cdp.send("PWA.uninstall", { manifestId });
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
