/* 云音播放器 Service Worker：应用壳缓存（cache-first），API 请求直连 */
const CACHE = "yunyin-v12";
const SHELL = [
  "./",
  "./index.html",
  "./player.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // 音乐 API / 歌词 / 封面 / 音频：直连，不缓存
  if (url.hostname.includes("injahow") || url.hostname.includes("163.com") ||
      url.hostname.includes("gdstudio") || url.hostname.includes("126.net") ||
      url.hostname.includes("cors.eu.org") || url.hostname.includes("allorigins") ||
      url.hostname.includes("codetabs")) {
    return;
  }
  // 应用壳：cache-first，后台更新
  if (e.request.method === "GET") {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        const fetching = fetch(e.request).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        }).catch(() => hit);
        return hit || fetching;
      })
    );
  }
});
