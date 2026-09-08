let privateEpoch = 0;
const STATIC = "heima-shell-v2";
const PRIVATE = "heima-private-shell-v1";
const GRANT = new URL("/__heima_offline_grant", self.location.origin).href;
const ASSETS = [
  "/offline.html",
  "/icon.svg",
  "/icon-180.png",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest",
];
const allowed = (pathname) =>
  pathname === "/work" ||
  pathname === "/shopping" ||
  pathname.startsWith("/shopping/");
async function grant() {
  const response = await (await caches.open(PRIVATE)).match(GRANT);
  if (!response) return null;
  const lease = await response.json();
  if (lease.expiresAt <= Date.now()) {
    await caches.delete(PRIVATE);
    return null;
  }
  return lease;
}
async function cacheStatic(paths) {
  const cache = await caches.open(STATIC);
  await Promise.allSettled(
    paths.map(async (path) => {
      const url = new URL(path, self.location.origin);
      if (
        url.origin !== self.location.origin ||
        !url.pathname.startsWith("/_next/static/")
      )
        return;
      if (await cache.match(url.href)) return;
      const response = await fetch(url.href);
      if (response.ok) await cache.put(url.href, response);
    }),
  );
}
async function remember(request, response) {
  const epoch = privateEpoch;
  if (
    response.ok &&
    !response.redirected &&
    response.headers.get("content-type")?.includes("text/html") &&
    allowed(new URL(response.url || request.url).pathname) &&
    (await grant())
  ) {
    const html = await response.clone().text();
    const paths = Array.from(
      html.matchAll(/(?:src|href)="([^"<>]*\/_next\/static\/[^"<>]*)"/g),
      (match) => match[1].replaceAll("&amp;", "&"),
    );
    await cacheStatic(paths);
    if (epoch !== privateEpoch || !(await grant())) return;
    await (await caches.open(PRIVATE)).put(request, response.clone());
    if (epoch !== privateEpoch) await caches.delete(PRIVATE);
  }
}
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("heima-shell-") && key !== STATIC)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("message", (event) => {
  if (
    event.data?.type === "HEIMA_EVICT" &&
    typeof event.data.path === "string" &&
    allowed(event.data.path)
  ) {
    privateEpoch++;
    event.waitUntil(
      caches
        .open(PRIVATE)
        .then((cache) =>
          cache.delete(new URL(event.data.path, self.location.origin)),
        ),
    );
  }
  if (event.data?.type === "HEIMA_PURGE") {
    privateEpoch++;
    event.waitUntil(caches.delete(PRIVATE));
  }
  if (event.data?.type === "HEIMA_LEASE")
    event.waitUntil(
      (async () => {
        const epoch = privateEpoch;
        const lease = event.data.lease;
        if (!lease || lease.expiresAt <= Date.now()) {
          await caches.delete(PRIVATE);
          return;
        }
        const old = await grant();
        if (
          old &&
          (old.actorId !== lease.actorId ||
            old.householdId !== lease.householdId)
        )
          await caches.delete(PRIVATE);
        if (epoch !== privateEpoch) return;
        await (await caches.open(PRIVATE)).put(
          GRANT,
          new Response(JSON.stringify(lease), {
            headers: { "Content-Type": "application/json" },
          }),
        );
        if (epoch !== privateEpoch) {
          await caches.delete(PRIVATE);
          return;
        }
        await cacheStatic(
          Array.isArray(event.data.staticPaths) ? event.data.staticPaths : [],
        );
        const path = event.data.path;
        if (
          typeof path === "string" &&
          path.startsWith("/") &&
          !path.startsWith("//") &&
          allowed(path)
        ) {
          try {
            const request = new Request(new URL(path, self.location.origin), {
              credentials: "same-origin",
            });
            const response = await fetch(request);
            await remember(request, response);
          } catch {}
        }
      })(),
    );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin)
    return;
  if (
    ASSETS.includes(url.pathname) ||
    url.pathname.startsWith("/_next/static/")
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC);
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const response = await fetch(event.request);
        if (response.ok) await cache.put(event.request, response.clone());
        return response;
      })(),
    );
    return;
  }
  if (event.request.mode === "navigate")
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(event.request);
          if (allowed(url.pathname)) await remember(event.request, response);
          return response;
        } catch {
          if (allowed(url.pathname) && (await grant())) {
            const cached = await (await caches.open(PRIVATE)).match(
              url.origin + url.pathname,
            );
            if (cached) return cached;
          }
          return caches.match("/offline.html");
        }
      })(),
    );
});
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification(
      typeof data.title === "string" ? data.title : "Heima",
      {
        body:
          typeof data.body === "string"
            ? data.body
            : "Your household has an update.",
        icon: "/icon.svg",
        badge: "/icon.svg",
        tag: data.id,
        data: {
          url:
            typeof data.url === "string" &&
            data.url.startsWith("/") &&
            !data.url.startsWith("//")
              ? data.url
              : "/settings/notifications",
        },
      },
    ),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(
      event.notification.data?.url || "/settings/notifications",
    ),
  );
});
