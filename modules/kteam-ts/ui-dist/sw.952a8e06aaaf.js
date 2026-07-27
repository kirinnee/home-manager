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
  var RELEASE_ID = "952a8e06aaaf";
  var PRECACHE_URLS = [
    "/assets/Markdown-Cf7zEfy1.js",
    "/assets/SessionChatPage-BVZyIfYR.js",
    "/assets/SessionChatPage-Ca8FHQ6p.css",
    "/assets/index-AB0yOWis.js",
    "/assets/index-BzfyMVYn.js",
    "/assets/index-DOml3kaE.css",
    "/assets/ort.bundle.min-B0AK_E7l.js",
    "/icons/apple-touch-icon.1d79d00c19.png",
    "/icons/favicon.1e0c791b41.ico",
    "/icons/favicon.fc09cfb83e.svg",
    "/icons/icon-192.4b80496b83.png",
    "/icons/icon-512.4d6591da01.png",
    "/icons/maskable-192.a2dc4e508d.png",
    "/icons/maskable-512.17e4f04ec4.png",
    "/offline.952a8e06aaaf.html"
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
  }
  if (typeof ServiceWorkerGlobalScope !== "undefined" && scope instanceof ServiceWorkerGlobalScope) {
    registerWorkerEvents(scope);
  }
})();
