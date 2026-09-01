/* 앱 껍데기만 캐시한다. 목록·카탈로그는 항상 서버에서 받아야 최신이므로 캐시하지 않는다. */
/* app.js·styles.css 는 여기 적지 않는다 — 판 번호가 붙은 주소로 불리므로
   여기 적힌 맨주소를 미리 받아 두면 쓰이지도 않을 옛 파일만 쥐고 있게 된다.
   아래 fetch 가 실제로 불린 주소를 그때그때 담으므로 오프라인에서도 열린다. */
const CACHE = "habhobby-shell-v2";
const SHELL = ["/", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;          // 상태는 항상 네트워크
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r ?? caches.match("/")))
  );
});
