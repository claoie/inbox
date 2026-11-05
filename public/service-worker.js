// Mail service worker
//
// Two responsibilities:
//   1. Push notifications (badge + system notification + server-side refresh
//      ping). Pre-existing; logic unchanged.
//   2. Cache-first for hashed assets (`/assets/*`). After every deploy,
//      Vite rewrites the content-hashed chunk filenames in `index.html`,
//      so users with stale tabs holding old chunk URLs were getting
//      `'text/html' is not a valid JavaScript MIME type.` because the SPA
//      catch-all served `index.html` for missing chunks (#501). With the
//      cache-first /assets/* tier here, the old chunks are served from
//      cache and the app keeps working until the user reloads. Mirrors
//      `budget/src/client/sw.ts` lines 63–79 (Hoie 2026-05-19).

const CACHE_NAME = "mail-v1";

self.addEventListener("install", (event) => {
  // Precache the SPA shell so it's available offline.
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.add("/"))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  // Drop old cache versions on a new SW activation.
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Never intercept API calls.
  if (url.pathname.startsWith("/api")) return;

  // Cache-first for hashed assets (JS, CSS under /assets/).
  // Vite embeds a content hash in every filename, so the URL itself
  // changes when the content changes — no stale data is ever served.
  // The cache holds whatever URLs were valid the last time the user
  // loaded; if a deploy invalidates them, the cached copies keep the
  // open tab working until the user reloads onto fresh HTML.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          });
        }),
      ),
    );
    return;
  }

  // Network-first for HTML navigation so fresh index.html is always used.
  // Always store under "/" so the SPA shell is found regardless of which
  // path the user was on when they last had network access.
  if (request.mode === "navigate") {
    const responsePromise = fetch(request);

    event.waitUntil(
      responsePromise
        .then((response) => {
          if (response.ok) {
            return caches
              .open(CACHE_NAME)
              .then((cache) => cache.put("/", response.clone()));
          }
        })
        .catch(() => {}),
    );

    event.respondWith(
      responsePromise.catch(async () => {
        const cached = await caches.match("/");
        return cached ?? new Response("Offline", { status: 503 });
      }),
    );
  }
});

self.addEventListener("push", (event) => {
  // Gate the entire handler on the user actually being opted in. Since
  // the SW is now registered for everyone (so the /assets/* cache tier
  // can help users who never enabled push), a push that arrives for a
  // user who has revoked notification permission or whose
  // pushManager.subscription was unsubscribed would otherwise throw on
  // showNotification (permission denied) and on the /api/push/refresh
  // call with a stale subscription_id (server 4xx). Bail out cleanly
  // when there's no active subscription or no notification permission.
  const handler = async () => {
    if (!event.data) return;
    if (self.Notification && self.Notification.permission !== "granted") return;
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return;

    let notification;
    try {
      notification = event.data.json();
    } catch {
      return;
    }
    if (!notification) return;

    const { push_subscription_id, title, icon, badge_count } = notification;

    const jobs = [];
    if (title) {
      jobs.push(self.registration.showNotification(title, { icon }).catch(() => {}));
    }
    if (badge_count !== undefined && self.navigator) {
      if (badge_count === 0 && self.navigator.clearAppBadge) {
        jobs.push(self.navigator.clearAppBadge().catch(() => {}));
      } else if (self.navigator.setAppBadge) {
        jobs.push(self.navigator.setAppBadge(badge_count).catch(() => {}));
      }
    }
    if (push_subscription_id) {
      jobs.push(
        fetch("/api/push/refresh/" + push_subscription_id).catch(() => {}),
      );
    }
    await Promise.all(jobs);
  };

  event.waitUntil(handler());
});
