/* 앱 껍데기만 캐시한다. 목록·카탈로그는 항상 서버에서 받아야 최신이므로 캐시하지 않는다. */
/* app.js·styles.css 는 여기 적지 않는다 — 판 번호가 붙은 주소로 불리므로
   여기 적힌 맨주소를 미리 받아 두면 쓰이지도 않을 옛 파일만 쥐고 있게 된다.
   아래 fetch 가 실제로 불린 주소를 그때그때 담으므로 오프라인에서도 열린다. */
const CACHE = "habhobby-shell-v4";
const SHELL = ["/", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* ── 공유는 여기서 가로채지 않는다 ──────────────────────────

   한때 이 워커가 POST /share 를 가로채 제목을 받아 오고 담기까지 했다. 지금은 서버가
   한다(intakeShared). 들어오는 문이 셋으로 늘었기 때문이다 — 브라우저의 웹 공유 대상,
   iOS 「단축어」, 안드로이드 앱. 뒤의 둘은 이 워커를 지나오지 않으므로, 여기에 판단을
   두면 같은 일을 하는 코드가 두 벌이 되고 언젠가 서로 다르게 군다.

   **워커를 거치나 안 거치나 같은 일이 일어나야 한다.** 그러려면 판단이 한 곳에 있어야
   하고, 셋이 모두 지나는 곳은 서버뿐이다. 여기서는 그냥 흘려보낸다(아래 fetch 가
   GET 만 잡는다) — 없앨 수 있는 코드가 가장 안 틀린다. */

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
