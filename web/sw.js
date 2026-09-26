const CACHE = "school-bus-v16";
const SHELL = "/staff";
const STATIC = [SHELL, "/styles.css", "/enhancements.css", "/routes.css", "/mobile-redesign.css", "/ux-polish.css", "/brand-theme.css", "/app.js", "/routes.js", "/manifest.webmanifest", "/app-icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  // 自分のオリジン以外は横取りしません。横取りすると、地図のタイルなど外部の取得を
  // ここで fetch し直すことになり、その fetch が Service Worker に掛かったCSP
  // (connect-src 'self') で弾かれて、画像が読めなくなります。
  if (url.origin !== location.origin) return;
  if (request.mode === "navigate") {
    // 職員用だけをオフライン起動の対象にします。一般用とダイヤ管理は常に最新を取得します。
    if (!url.pathname.startsWith("/staff")) return;
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(SHELL, copy));
      return response;
    }).catch(() => caches.match(SHELL)));
    return;
  }
  event.respondWith(fetch(request).then((response) => {
    if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
    return response;
  }).catch(async () => {
    // 控えがあればそれを返します。無いときに undefined を返すと、
    // 呼び出し側では原因の分からないネットワークエラーになります。
    const cached = await caches.match(request);
    if (cached) return cached;
    throw new Error("オフラインで、控えもありません");
  }));
});
