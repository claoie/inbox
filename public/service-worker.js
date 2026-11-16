// Mail service worker
//
// Two responsibilities:
//   1. Push notifications (badge + system notification + server-side refresh
//      ping). Pre-existing; logic unchanged.
//   2. Cache-first for hashed assets (`/assets/*`). A deploy deletes the
//      previous build's content-hashed files, and the SPA catch-all answers
//      a request for one with `index.html`. The worker caches the current
//      build, the previous one, and every build an open window still runs,
//      so a tab left open keeps working across any number of deploys.

const CACHE_NAME = "mail-v1";
const ASSET_MANIFEST = "/asset-manifest.json";

const asPaths = (value) =>
  Array.isArray(value) ? value.filter((a) => typeof a === "string") : undefined;

const isCacheableAsset = (response) =>
  response.ok && !(response.headers.get("Content-Type") || "").includes("text/html");

const readJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

// Cache reads and writes of the stored manifest are read-modify-write, and
// several windows can report their build while a precache is running.
let queue = Promise.resolve();
const serialized = (task) => {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
};

const readStored = async (cache) => {
  const response = await cache.match(ASSET_MANIFEST);
  const stored = (response && (await readJson(response))) || {};
  const retained = Array.isArray(stored.retained)
    ? stored.retained.map(asPaths).filter(Boolean)
    : [];
  const windows = Object.fromEntries(
    Object.entries(
      stored.windows && typeof stored.windows === "object" ? stored.windows : {},
    ).filter(
      ([, w]) => w && typeof w.entry === "string" && typeof w.reportedAt === "number",
    ),
  );
  return {
    current: asPaths(stored.current) || [],
    previous: asPaths(stored.previous) || [],
    retained,
    windows,
  };
};

const writeStored = (cache, stored) =>
  cache.put(
    ASSET_MANIFEST,
    new Response(JSON.stringify(stored), {
      headers: { "Content-Type": "application/json" },
    }),
  );

const openWindowIds = async () => {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return new Set(windows.map((w) => w.id));
};

// Suspended and back/forward-cached windows may be missing from matchAll, so a
// window that stops being listed still holds its build until its last report
// is older than this.
const UNLISTED_WINDOW_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// A build stays cached while any open window still runs it, however many
// deploys ago it was loaded; current and previous cover windows that have not
// reported their build yet.
const prune = async (cache, stored) => {
  const openIds = await openWindowIds();
  const now = Date.now();
  const windows = Object.fromEntries(
    Object.entries(stored.windows).filter(
      ([id, w]) => openIds.has(id) || now - w.reportedAt < UNLISTED_WINDOW_TTL_MS,
    ),
  );
  const runningEntries = new Set(Object.values(windows).map((w) => w.entry));
  const isRunning = (build) => build.some((a) => runningEntries.has(a));

  const currentKey = stored.current.join();
  const previous = stored.previous.join() === currentKey ? [] : stored.previous;
  const seen = new Set([currentKey, previous.join()]);
  const retained = stored.retained.filter((build) => {
    const key = build.join();
    if (!build.length || seen.has(key) || !isRunning(build)) return false;
    seen.add(key);
    return true;
  });

  const keep = new Set([stored.current, previous, ...retained].flat());
  const requests = await cache.keys();
  await Promise.all(
    requests
      .filter((r) => {
        const { pathname } = new URL(r.url);
        return pathname.startsWith("/assets/") && !keep.has(pathname);
      })
      .map((r) => cache.delete(r)),
  );
  return { current: stored.current, previous, retained, windows };
};

// The first page load bypasses this worker and unvisited route chunks are never
// fetched, so the fetch handler alone never holds a whole build.
const precacheBuild = async () => {
  const response = await fetch(ASSET_MANIFEST, { cache: "no-store" });
  if (!response.ok) return;
  const current = asPaths(await readJson(response));
  if (!current) return;

  const cache = await caches.open(CACHE_NAME);
  const requests = await cache.keys();
  const cachedPaths = new Set(requests.map((r) => new URL(r.url).pathname));
  await Promise.all(
    current
      .filter((a) => !cachedPaths.has(a))
      .map((a) =>
        fetch(a)
          .then((r) => isCacheableAsset(r) && cache.put(a, r))
          .catch(() => {}),
      ),
  );

  await serialized(async () => {
    const stored = await readStored(cache);
    const isNewBuild = current.join() !== stored.current.join();
    const next = isNewBuild
      ? { ...stored, current, previous: stored.current, retained: [stored.previous, ...stored.retained] }
      : stored;
    await writeStored(cache, await prune(cache, next));
  });
};

const recordWindowBuild = (windowId, entry) =>
  serialized(async () => {
    const cache = await caches.open(CACHE_NAME);
    const stored = await readStored(cache);
    const windows = { ...stored.windows, [windowId]: { entry, reportedAt: Date.now() } };
    await writeStored(cache, { ...stored, windows });
  });

self.addEventListener("message", (event) => {
  const { data, source } = event;
  if (!source || !data || data.type !== "build" || typeof data.entry !== "string") return;
  event.waitUntil(recordWindowBuild(source.id, data.entry).catch(() => {}));
});

self.addEventListener("install", (event) => {
  // Precache the SPA shell so it's available offline, and the build here
  // rather than in activate: WebKit holds every fetch while a worker activates.
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.add("/"))
      .then(() => precacheBuild().catch(() => {}))
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
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request).then((response) => {
            if (isCacheableAsset(response)) cache.put(request, response.clone());
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
            // Clone before respondWith starts reading the body, or the clone throws.
            const shell = response.clone();
            return caches
              .open(CACHE_NAME)
              .then((cache) => cache.put("/", shell))
              .then(() => precacheBuild().catch(() => {}));
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
