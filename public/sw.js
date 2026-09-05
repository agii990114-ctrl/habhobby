/* 앱 껍데기만 캐시한다. 목록·카탈로그는 항상 서버에서 받아야 최신이므로 캐시하지 않는다. */
/* app.js·styles.css 는 여기 적지 않는다 — 판 번호가 붙은 주소로 불리므로
   여기 적힌 맨주소를 미리 받아 두면 쓰이지도 않을 옛 파일만 쥐고 있게 된다.
   아래 fetch 가 실제로 불린 주소를 그때그때 담으므로 오프라인에서도 열린다. */
const CACHE = "habhobby-shell-v3";
const SHELL = ["/", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* ── 공유로 들어온 것 ────────────────────────────────────────

   **여기서 담고 끝낸다.** share_target 이 POST 라서 이 워커가 가로챌 수 있고,
   가로챈 뒤에는 화면이 뜨기 전에 저장까지 마칠 수 있다. GET 이던 때는 주소로 이동해
   버려서, 창이 뜨고 등록 화면이 서고 사람이 「담기」를 눌러야 끝났다.

   **웹으로는 창이 뜨는 것 자체를 막을 수 없다** — Web Share Target 은 대상 앱을 열도록
   정해져 있다. 없앨 수 있는 것은 「손이 가는 일」뿐이라 그것을 없앤다.

   **제목을 사이트에서 읽어 왔을 때만 말없이 담는다.** origin 이 "og" 가 아니면 제목은
   주소에서 짐작한 것이라(resolve.ts), 그대로 담으면 목록에 알아볼 수 없는 줄이 선다.
   그때는 담지 않고 등록 화면으로 넘겨 사람에게 묻는다 — 조용히 틀리게 담는 것보다 낫다.

   **filed: false 로 담는다.** 공유로 들어온 것은 「일단 받아 둔 것」이라 폴더가 없다.
   앱이 그것을 「새 콘텐츠」로 모아 두고 ＋ 에 숫자를 달아 주므로(unfiled), 나중에
   한꺼번에 정리하면 된다 — 등록 화면이 fromShare 일 때 하던 것과 같은 판단이다. */
async function handleShare(req) {
  const home = q => Response.redirect(new URL("/" + q, location.origin).href, 303);
  let raw = "";
  try {
    const f = await req.formData();
    raw = String(f.get("url") || f.get("text") || f.get("title") || "");
  } catch { /* 몸통을 못 읽으면 빈손으로 연다 */ }

  // 「제목 https://…」 처럼 글이 섞여 와도 주소만 집는다 (앱의 부팅 코드와 같은 잣대)
  const m = raw.match(/https?:\/\/\S+/);
  const url = m ? m[0] : raw.trim();
  if (!url) return home("");
  const ask = () => home("?text=" + encodeURIComponent(raw || url));

  try {
    const r = await fetch("/api/resolve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }).then(x => x.json());
    if (!r.ok || r.origin !== "og") return ask();

    const made = await fetch("/api/works", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, title: r.title, schedule: r.schedule, filed: false }),
    }).then(x => x.json());
    if (!made.ok) return ask();

    /* 만든 것과 고친 것은 다른 일이다 — 화면이 다른 말을 하도록 함께 넘긴다
       (등록 화면의 토스트와 같은 규칙). */
    return home("?saved=" + encodeURIComponent(made.work.title) + (made.made ? "" : "&again=1"));
  } catch {
    return ask();      // 서버가 안 잡히면 사람에게 넘긴다. 조용히 삼키지 않는다.
  }
}

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.pathname === "/share" && url.origin === location.origin) {
    e.respondWith(handleShare(e.request));
    return;
  }
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
