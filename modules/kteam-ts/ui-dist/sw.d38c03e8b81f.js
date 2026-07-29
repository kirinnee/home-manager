(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  function __accessProp(key) {
    return this[key];
  }
  var __toCommonJS = (from) => {
    var entry = (__moduleCache ??= new WeakMap).get(from), desc;
    if (entry)
      return entry;
    entry = __defProp({}, "__esModule", { value: true });
    if (from && typeof from === "object" || typeof from === "function") {
      for (var key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(entry, key))
          __defProp(entry, key, {
            get: __accessProp.bind(from, key),
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
          });
    }
    __moduleCache.set(from, entry);
    return entry;
  };
  var __moduleCache;
  var __returnValue = (v) => v;
  function __exportSetter(name, newValue) {
    this[name] = __returnValue.bind(null, newValue);
  }
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, {
        get: all[name],
        enumerable: true,
        configurable: true,
        set: __exportSetter.bind(all, name)
      });
  };

  // sw/sw.ts
  var exports_sw = {};
  __export(exports_sw, {
    registerWorkerEvents: () => registerWorkerEvents,
    onInstall: () => onInstall,
    onActivate: () => onActivate
  });

  // sw/precache.gen.ts
  var RELEASE_ID = "d38c03e8b81f";
  var PRECACHE_URLS = [
    "/assets/AnalyticsSurface-C545H1Mg.js",
    "/assets/GlobalAnalyticsPage-CRUM7lwK.js",
    "/assets/SessionChatPage-Dly7OL2u.js",
    "/assets/SessionChatPage-DqXxC6aV.css",
    "/assets/addon-fit-DOCEibfw.js",
    "/assets/index-BP5fu-1j.js",
    "/assets/index-DkSArfRC.js",
    "/assets/index-DmD7VqpJ.css",
    "/assets/ort.bundle.min-B0AK_E7l.js",
    "/assets/remote-enhancement-5KpOO41n.js",
    "/assets/xterm-CASmyfyk.js",
    "/icons/apple-touch-icon.1d79d00c19.png",
    "/icons/favicon.1e0c791b41.ico",
    "/icons/favicon.fc09cfb83e.svg",
    "/icons/icon-192.4b80496b83.png",
    "/icons/icon-512.4d6591da01.png",
    "/icons/maskable-192.a2dc4e508d.png",
    "/icons/maskable-512.17e4f04ec4.png",
    "/offline.d38c03e8b81f.html"
  ];

  // sw/policy.ts
  var CACHE_PREFIX = "kteam-shell-";
  var INDEX_CACHE = `${CACHE_PREFIX}index`;
  var INDEX_KEY = "/__kteam-shell-generations";
  var RETAINED_GENERATIONS = 3;
  function cacheNameFor(release) {
    return `${CACHE_PREFIX}${release}`;
  }
  function offlineUrl(release) {
    return `/offline.${release}.html`;
  }
  var API_PREFIX = "/v1/";
  function fetchPolicy(method, url, workerOrigin, isNavigate) {
    if (method !== "GET")
      return "passthrough";
    if (url.origin !== workerOrigin)
      return "passthrough";
    if (url.pathname === "/v1" || url.pathname.startsWith(API_PREFIX))
      return "passthrough";
    if (isNavigate)
      return "navigate";
    if (url.pathname === INDEX_KEY)
      return "network";
    return "cache-first";
  }
  function nextGenerationOrder(existing, release) {
    return [...existing.filter((r) => r !== release), release];
  }
  function retainedGenerations(order, keep = RETAINED_GENERATIONS) {
    return keep <= 0 ? [] : order.slice(-keep);
  }
  function cachesToDelete(existing, retained) {
    const keep = new Set(retained.map(cacheNameFor));
    return existing.filter((name) => name.startsWith(CACHE_PREFIX) && name !== INDEX_CACHE && !keep.has(name));
  }
  function releasesFromCacheNames(existing) {
    return existing.filter((name) => name.startsWith(CACHE_PREFIX) && name !== INDEX_CACHE).map((name) => name.slice(CACHE_PREFIX.length));
  }
  function reconcileGenerationOrder(recorded, existing) {
    const discovered = releasesFromCacheNames(existing);
    const alive = new Set(discovered);
    const known = recorded.filter((r) => alive.has(r));
    const authoritative = known.length === discovered.length && new Set(known).size === known.length;
    return authoritative ? known : discovered;
  }
  async function readGenerationOrder() {
    try {
      const cache = await caches.open(INDEX_CACHE);
      const hit = await cache.match(INDEX_KEY);
      if (!hit)
        return [];
      const parsed = await hit.json();
      if (!Array.isArray(parsed))
        return [];
      return parsed.filter((r) => typeof r === "string");
    } catch {
      return [];
    }
  }
  async function writeGenerationOrder(order) {
    const cache = await caches.open(INDEX_CACHE);
    await cache.put(INDEX_KEY, new Response(JSON.stringify(order), {
      headers: { "content-type": "application/json" }
    }));
  }
  async function precacheAll(cache, urls, base) {
    const fetched = await Promise.all(urls.map(async (url) => {
      const response = await fetch(new Request(new URL(url, base).href, { cache: "reload" }));
      if (!response.ok) {
        throw new Error(`sw: refusing to install — ${url} responded ${response.status}`);
      }
      return {
        url,
        body: await response.arrayBuffer(),
        headers: response.headers,
        status: response.status
      };
    }));
    await Promise.all(fetched.map(({ url, body, headers, status }) => cache.put(url, new Response(body, { headers, status }))));
  }
  async function installRelease(release, urls, base) {
    const name = cacheNameFor(release);
    const cache = await caches.open(name);
    try {
      await precacheAll(cache, urls, base);
    } catch (error) {
      await caches.delete(name).catch(() => false);
      throw error;
    }
  }
  async function activateRelease(release) {
    const existing = await caches.keys();
    const recorded = reconcileGenerationOrder(await readGenerationOrder(), existing);
    const order = nextGenerationOrder(recorded, release);
    const retained = retainedGenerations(order);
    await Promise.all(cachesToDelete(existing, retained).map((name) => caches.delete(name)));
    await writeGenerationOrder(retained);
  }
  async function respond(request, policy, release) {
    if (policy === "passthrough")
      return;
    if (policy === "navigate") {
      try {
        return await fetch(request);
      } catch {
        const offline = await caches.match(offlineUrl(release));
        return offline ?? Response.error();
      }
    }
    if (policy === "cache-first") {
      const hit = await caches.match(request);
      if (hit)
        return hit;
      return await fetch(request);
    }
    return await fetch(request);
  }

  // sw/notify.ts
  var PUSH_KINDS = new Set(["attention", "question", "failed", "completed"]);
  function parsePushPayload(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const raw = value;
    if (raw["version"] !== 1)
      return null;
    const title = raw["title"];
    const body = raw["body"];
    const tag = raw["tag"];
    const url = raw["url"];
    const eventKey = raw["eventKey"];
    const count = raw["count"];
    if (typeof title !== "string" || !title.trim() || title.length > 120)
      return null;
    if (typeof body !== "string" || body.length > 240)
      return null;
    if (typeof tag !== "string" || !/^kteam-[A-Za-z0-9_-]+$/u.test(tag) || tag.length > 160)
      return null;
    if (typeof url !== "string" || targetPath({ url }) !== url)
      return null;
    if (typeof eventKey !== "string" || !eventKey || eventKey.length > 512)
      return null;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > 100)
      return null;
    const sessionId = raw["sessionId"];
    if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId || sessionId.length > 160))
      return null;
    const wireKind = raw["kind"];
    const kind = wireKind === "needsYou" ? "attention" : wireKind;
    if (kind !== undefined && (typeof kind !== "string" || !PUSH_KINDS.has(kind)))
      return null;
    return {
      version: 1,
      eventKey,
      title: title.trim(),
      body,
      tag,
      url,
      count,
      ...sessionId === undefined ? {} : { sessionId },
      ...kind === undefined ? {} : { kind }
    };
  }
  function groupedNotificationBody(latest, count) {
    return count > 1 ? `${latest}
+${count - 1} more` : latest;
  }
  function planNotificationPresentation(payload, existing) {
    if (existing.some((item) => item.eventKey === payload.eventKey))
      return { action: "skip" };
    let count = payload.count;
    if (payload.sessionId) {
      const activeCount = existing.reduce((highest, item) => typeof item.count === "number" && Number.isSafeInteger(item.count) && item.count > highest ? item.count : highest, 0);
      if (activeCount > 0)
        count = Math.max(count, Math.min(100, activeCount + 1));
    }
    return {
      action: "show",
      body: groupedNotificationBody(payload.body, count),
      count,
      data: { url: payload.url, eventKey: payload.eventKey, count, latestBody: payload.body }
    };
  }
  async function showGroupedNotification(registration, payload) {
    const notifications = await registration.getNotifications({ tag: payload.tag });
    const plan = planNotificationPresentation(payload, notifications.map((notification) => notification.data && typeof notification.data === "object" ? notification.data : {}));
    if (plan.action === "skip")
      return "duplicate";
    const options = {
      body: plan.body,
      tag: payload.tag,
      renotify: false,
      data: plan.data
    };
    await registration.showNotification(payload.title, options);
    return "shown";
  }
  function targetPath(data) {
    if (data && typeof data === "object") {
      const url = data.url;
      if (typeof url === "string" && url.startsWith("/") && !url.startsWith("//"))
        return url;
    }
    return "/";
  }
  function alreadyAt(clientUrl, path, origin) {
    try {
      const url = new URL(clientUrl);
      if (url.origin !== origin)
        return false;
      return url.pathname === path;
    } catch {
      return false;
    }
  }
  function planClick(clients, path, origin) {
    for (const client of clients) {
      try {
        if (new URL(client.url).origin !== origin)
          continue;
      } catch {
        continue;
      }
      return { action: "focus", client, navigate: !alreadyAt(client.url, path, origin) };
    }
    return { action: "open" };
  }
  async function runClick(plan, path, openWindow) {
    if (plan.action === "open") {
      await openWindow(path).catch(() => {
        return;
      });
      return;
    }
    await plan.client.focus().catch(() => {
      return;
    });
    if (plan.navigate && typeof plan.client.navigate === "function") {
      await plan.client.navigate(path).catch(() => {
        return;
      });
    }
  }

  // sw/sw.ts
  var scope = self;
  async function onInstall() {
    await installRelease(RELEASE_ID, PRECACHE_URLS, scope.location.href);
  }
  async function onActivate() {
    await activateRelease(RELEASE_ID);
  }
  function registerWorkerEvents(sw) {
    sw.addEventListener("install", (event) => {
      event.waitUntil(onInstall());
    });
    sw.addEventListener("activate", (event) => {
      event.waitUntil(onActivate());
    });
    sw.addEventListener("fetch", (event) => {
      const request = event.request;
      let url;
      try {
        url = new URL(request.url);
      } catch {
        return;
      }
      const policy = fetchPolicy(request.method, url, sw.location.origin, request.mode === "navigate");
      if (policy === "passthrough")
        return;
      event.respondWith(respond(request, policy, RELEASE_ID));
    });
    sw.addEventListener("message", (event) => {
      if (event.data?.type === "SKIP_WAITING") {
        sw.skipWaiting();
      }
    });
    sw.addEventListener("push", (event) => {
      event.waitUntil((async () => {
        let decoded;
        try {
          decoded = event.data ? JSON.parse(event.data.text()) : null;
        } catch {
          return;
        }
        const payload = parsePushPayload(decoded);
        if (!payload)
          return;
        const windows = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
        if (windows.some((client) => client.visibilityState === "visible"))
          return;
        await showGroupedNotification(sw.registration, payload);
      })());
    });
    sw.addEventListener("notificationclick", (event) => {
      event.notification.close();
      const path = targetPath(event.notification.data);
      event.waitUntil((async () => {
        const clients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
        const plan = planClick(clients, path, sw.location.origin);
        await runClick(plan, path, (url) => sw.clients.openWindow(url));
      })());
    });
  }
  if (typeof ServiceWorkerGlobalScope !== "undefined" && scope instanceof ServiceWorkerGlobalScope) {
    registerWorkerEvents(scope);
  }
})();
