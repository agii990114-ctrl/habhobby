/* 공유받은 URL 하나로 제목과 표지를 얻는다.

   경로는 하나뿐이다 — Open Graph 태그.
   사이트가 "이 페이지를 소개할 땐 이걸 써달라"고 스스로 공개해 둔 메타데이터이고,
   카카오톡·슬랙의 링크 미리보기가 읽는 바로 그것이다. 플랫폼의 비공개 내부
   엔드포인트는 쓰지 않으므로, 어떤 플랫폼이든 같은 방식으로 다룬다.

   연재 일정은 자동으로 얻지 않는다. OG 규격에 그런 항목이 없고, 그걸 얻으려면
   각 플랫폼의 내부 통로를 열어야 하기 때문이다. 요일은 사용자가 정한다. */
import { parseShared, isShortener, extractUrl, registrableDomain, type Platform } from "./platforms.ts";

const UA = "Mozilla/5.0 (compatible; HabHobby/0.1; link-preview)";
const TIMEOUT = 12_000;

export type Resolved =
  | {
      ok: true;
      platform: { id: string; name: string; color: string; fg: string; initial: string };
      seriesId: string;
      title: string;
      coverUrl: string | null;
      coverAspect: number | null;
      listUrl: string;
      appUrl: string | null;
      episode: string | null;
      mediaType: string;
      schedule: { mode: string; days: number[]; next: number | null; source: "auto" | "user" };
      /** 제목이 어디서 왔는지 — 화면이 "왜 비었는지"를 설명할 수 있어야 한다.
          none 과 blocked 는 결과가 같아 보여도 원인이 다르다:
          앞은 사이트가 안 내놓는 것, 뒤는 우리를 막은 것이다. */
      origin: "og" | "none" | "blocked";
      /** 그 페이지가 **없다**고 확신할 때만 채운다. 못 읽은 것과는 다르다. */
      dead: "notfound" | "moved" | "generic" | "nohost" | null;
      /** 그쪽이 돌려준 번호 (0 이면 못 닿음) — 화면이 왜 그런지 말해 줄 때 쓴다 */
      status: number;
      note?: string;
    }
  | { ok: false; reason: string };

/** 단축 URL은 리다이렉트를 한 번 따라가야 원본이 나온다. 브라우저로는 못 하는 일. */
async function unshorten(raw: string): Promise<string> {
  if (!isShortener(raw)) return raw;
  const url = /^https?:/i.test(raw) ? raw : "https://" + raw;
  try {
    const res = await fetch(url, {
      method: "HEAD", redirect: "follow",
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT),
    });
    return res.url || raw;
  } catch { return raw; }
}

const decodeEntities = (s: string): string => s
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&");

/** "템빨 | 카카오웹툰" → "템빨", "오징어 게임… | 넷플릭스 공식 사이트" → "오징어 게임…".

    구분자로 자른 마지막 조각이 사이트 이름을 담고 있을 때만 떼어낸다.
    og:site_name 이 없는 사이트가 많아서 플랫폼 이름으로도 대조하되,
    조각이 짧고 앞부분이 남을 때만 지운다 — 제목에 구분자가 든 작품을 망가뜨리지 않기 위해. */
export function stripSiteSuffix(title: string, ...names: (string | null | undefined)[]): string {
  const marks = names.map(n => (n ?? "").trim()).filter(Boolean);
  if (!marks.length) return title;

  for (const sep of ["|", "ㅣ", "–", "—", "::", " - ", " : "]) {
    const at = title.lastIndexOf(sep);
    if (at <= 0) continue;
    const head = title.slice(0, at).trim();
    const tail = title.slice(at + sep.length).trim();
    if (!head || !tail || tail.length > 40) continue;
    if (marks.some(m => tail.includes(m) || m.includes(tail))) return head;
  }
  return title;
}

type Og = { read: boolean; title: string | null; image: string | null; siteName: string | null;
             url: string | null; imgW: number | null; imgH: number | null;
             /** 그쪽이 돌려준 번호. 못 닿았으면 0. */
             status: number;
             /** 물어본 곳과 **다른 곳**에 닿았으면 그 최종 주소 (없는 작품은 대문으로 튕긴다) */
             landed: string | null };

async function fetchOg(url: string): Promise<Og> {
  const empty: Og = { read: false, title: null, image: null, siteName: null, url: null,
                      imgW: null, imgH: null, status: 0, landed: null };
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    /* 못 읽었어도 **번호는 넘긴다.** 404 와 403 은 뜻이 아주 다르다 —
       앞은 그 페이지가 없는 것이고, 뒤는 있는데 우리를 막은 것이다(CGV 가 그렇다). */
    if (!res.ok) return { ...empty, status: res.status };
    // meta 태그는 <head> 안에 있다. 유튜브처럼 head가 700KB에 달하는 페이지가 있어
    // 고정 길이로 자르면 태그를 놓친다 — </head>까지 읽되 상한을 둔다.
    const MAX = 1_500_000;
    const raw = (await res.text()).slice(0, MAX);
    const end = raw.search(/<\/head\s*>/i);
    const html = end >= 0 ? raw.slice(0, end) : raw.slice(0, 300_000);
    const pick = (prop: string): string | null => {
      const a = new RegExp(
        `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i");
      const b = new RegExp(
        `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i");
      const m = html.match(a) ?? html.match(b);
      if (!m) return null;
      // 태그 안에 줄바꿈과 들여쓰기가 그대로 들어 있는 페이지가 있다.
      // 그대로 두면 제목 한 줄이 화면을 가로질러 버린다 — 공백은 한 칸으로 줄인다.
      return decodeEntities(m[1]).replace(/\s+/g, " ").trim() || null;
    };
    let title = pick("og:title") ?? pick("twitter:title");
    if (!title) {
      const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      title = m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() || null : null;
    }
    const num = (v: string | null): number | null => {
      const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null;
    };
    return {
      read: true,
      status: res.status,
      /* 없는 작품 번호를 넣으면 404 가 아니라 **대문으로 튕긴다**(네이버가 그렇다).
         물어본 곳과 닿은 곳이 다르면 그것이 신호다. 리다이렉트는 이미 따라가고 있어
         새로 두드릴 것이 없다. */
      landed: res.url && res.url !== url ? res.url : null,
      title,
      image: pick("og:image") ?? pick("twitter:image"),
      siteName: pick("og:site_name"),
      // 이 태그들이 **이 페이지 것인지** 가리는 데 쓴다 (아래 pageIsGeneric 참고)
      url: pick("og:url"),
      // 사이트가 알려주면 비율을 알 수 있다 — 가로 배너를 세로 칸에 억지로 채우지 않기 위해
      imgW: num(pick("og:image:width")),
      imgH: num(pick("og:image:height")),
    };
  } catch (e) {
    /* **못 닿은 까닭을 가린다.** 「그런 도메인이 없다」(ENOTFOUND)와 「느리거나 막혔다」는
       뜻이 아주 다르다 — 앞은 주소를 잘못 친 것이고, 뒤는 그쪽 사정이다.
       도메인이 없는 것만 -1 로 표시해 두고, 나머지는 0(그냥 못 읽음)으로 둔다. */
    const code = (e as { cause?: { code?: string } })?.cause?.code;
    return { ...empty, status: code === "ENOTFOUND" ? -1 : 0 };
  }
}

/** 구간 제목으로 쓸 만한 값인지 — 지나치게 길거나 빈 값은 주소만도 못하다. */
function cleanSiteName(raw: string | null): string | null {
  const n = (raw ?? "").trim().replace(/\s+/g, " ");
  return n && n.length <= 40 ? n : null;
}

/* 사이트 이름은 홈페이지 제목에 거의 항상 들어 있다. 다만 표어가 붙어 있어서
   "Hugging Face – The AI community building the future" 처럼 온다 — 앞부분만 잘라 쓴다. */
const NAME_SEPS = ["–", "—", " - ", " | ", "|", "·", "ㅣ", " : ", ":", ","];

/** 도메인의 핵심 낱말. brunch.co.kr → "brunch", ko.wikipedia.org → "wikipedia". */
function domainCore(host: string): string {
  return registrableDomain(host.replace(/^www\./, "")).split(".")[0] ?? "";
}

/** 홈페이지 제목 → 사이트 이름. 못 고르겠으면 null (주소를 그대로 쓰는 게 낫다). */
export function siteNameFromTitle(title: string, host: string): string | null {
  const t = (title ?? "").trim().replace(/\s+/g, " ");
  if (!t) return null;

  // 가장 먼저 나오는 구분자에서 자른다 — 이름이 앞, 표어가 뒤인 게 보통이다
  let at = -1, sep = "";
  for (const s of NAME_SEPS) {
    const i = t.indexOf(s);
    if (i > 0 && (at < 0 || i < at)) { at = i; sep = s; }
  }
  const segs = at < 0 ? [t] : [t.slice(0, at).trim(), t.slice(at + sep.length).trim()];

  // 표어가 앞에 오는 사이트도 있으므로, 도메인과 같은 조각이 있으면 그쪽을 믿는다
  const core = domainCore(host).toLowerCase();
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
  const picked = segs.find(x => x && norm(x) === core) ?? segs[0];

  // 잘라내고도 길면 이름이 아니라 문장을 집은 것이다
  return picked && picked.length <= 24 ? picked : null;
}

/** 도메인 구간에 붙일 이름. 개별 글이 아니라 **홈페이지**에 묻는다 —
    사이트가 스스로를 뭐라 부르는지는 대문에 적혀 있고, 글 페이지만 막아둔 곳도 많다.

    "읽었는데 이름이 없다"와 "못 읽었다"를 구분한다 — 앞의 것은 다시 물어도 소용없지만
    뒤의 것은 막혔거나 잠깐 죽은 것이라 나중에 되기도 한다. */
export async function fetchSiteName(host: string): Promise<{ read: boolean; name: string | null }> {
  const og = await fetchOg(`https://${host}/`);
  if (!og.read) return { read: false, name: null };
  return { read: true, name: cleanSiteName(og.siteName) ?? siteNameFromTitle(og.title ?? "", host) };
}

/** 받아온 태그가 **이 페이지 것이 아닌지** 가린다.

    카카오페이지처럼 화면을 브라우저에서 그리는 곳은, 어느 작품 주소로 들어가도 서버가
    똑같은 대문용 태그를 내놓는다 — 제목은 사이트 이름, og:url 은 대문, 그림은 공용 로고다.
    그걸 그대로 담으면 작품마다 같은 로고가 표지로 붙는다.

    가리는 잣대는 셋이고, 어느 쪽도 사이트 이름을 적어 두지 않는다.

    ① 제목이 플랫폼·도메인 이름과 똑같다 — 작품 이야기가 아니다.
    ② **이름 없이 그림만** 있다 — 제 이야기를 하는 페이지는 이름부터 밝힌다.
    ③ **깊은 주소를 물었는데** og:url 이 대문(/)을 가리키고, **제목마저 사이트 이름**이다.

    ②는 두 신호가 겹칠 때만 본다. og:url 하나만으로 버리면, 그 태그를 대충 적어 두었을 뿐
    제목과 그림은 멀쩡한 곳까지 잃는다. 대문을 물은 경우(블로그 홈처럼 제목이 곧 사이트
    이름인 곳)는 깊은 주소가 아니라 애초에 걸리지 않는다. */
function pageIsGeneric(og: Og, askedUrl: string, plat: Platform, title: string): boolean {
  /* 견줄 때 공백을 지운다. 네이버는 없는 작품 번호에 대문 정보를 주는데, 그 제목이
     "네이버 웹툰" 이고 우리 쪽 이름은 "네이버웹툰" 이라 띄어쓰기 하나로 안 걸렸다 —
     없는 작품이 「네이버 웹툰」이라는 제목으로 조용히 담겼다. */
  const flat = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  if (title && (flat(title) === flat(plat.name) || flat(title) === flat(plat.id.replace("domain:", "")))) return true;
  /* 이름은 없는데 그림만 있다 — 제 이야기를 하는 페이지는 이름부터 밝힌다. 이름 없이
     그림만 내놓는 곳은 대개 서비스 공용 로고를 준다. 네이버 지도가 그렇다: 가게 페이지를
     브라우저에서 그려서 서버 HTML 에는 상호가 아예 없고, og:image 로는 지도 서비스
     로고(og-map-400x200.png) 하나만 준다. 그걸 담으면 어느 가게를 담아도 같은 회색
     지도가 표지로 붙는다. */
  if (!title && og.image) return true;
  if (!og.url) return false;
  if (title && og.siteName && title !== og.siteName) return false;   // 제목은 제 이야기를 한다
  try {
    const said = new URL(og.url), asked = new URL(askedUrl);
    const shallow = said.pathname === "/" || said.pathname === "";
    const deep = asked.pathname !== "/" && asked.pathname !== "";
    return shallow && deep;
  } catch { return false; }
}

/* 주소창에 한 글자 멈출 때마다(0.4초) 이쪽이 불린다. 지우고 다시 치거나, 안 되는 줄
   알고 같은 주소를 두어 번 넣어 보는 일이 흔한데 그때마다 남의 페이지를 새로 긁었다.
   같은 주소를 잠깐 기억해 둔다 — 짧게 두는 이유는 표지나 제목이 바뀌었을 때 영영 옛것을
   붙들고 있지 않기 위해서다. 실패는 기억하지 않는다(잠깐 죽은 것일 수 있다).

   *** 뜻이 있는 부수 효과: 남의 서버를 두드리는 횟수가 줄어 차단당할 일도 준다. */
const MEMO_MS = 10 * 60 * 1000;
const memo = new Map<string, { at: number; got: Resolved }>();

export async function resolveUrl(raw: string): Promise<Resolved> {
  const key = raw.trim();
  const seen = memo.get(key);
  if (seen && Date.now() - seen.at < MEMO_MS) return seen.got;

  const got = await resolveOnce(raw);
  /* 못 읽은 것(blocked)은 기억하지 않는다 — 잠깐 죽었거나 느렸을 뿐일 수 있고,
     그걸 10분 붙들면 다시 넣어 보는 사람에게 같은 실패만 되돌려 준다. */
  if (got.ok && got.origin !== "blocked") {
    if (memo.size >= 300) memo.clear();      // 오래 도는 서버에서 끝없이 불어나지 않게
    memo.set(key, { at: Date.now(), got });
  }
  return got;
}

async function resolveOnce(raw: string): Promise<Resolved> {
  // 주소를 먼저 골라낸다. 공유받은 문자열은 제목이 붙어 있어서, 그대로는
  // 단축 주소인지조차 알아볼 수 없다 — 그러면 리다이렉트를 못 따라간다.
  const p = parseShared(await unshorten(extractUrl(raw)));
  if (!p.ok) return { ok: false, reason: p.reason };

  const plat: Platform = p.platform;
  const og = await fetchOg(p.listUrl);
  // 플랫폼이 더 나은 표지를 알고 있으면 그것으로 바꾼다 (예: 레진 wide → tall)
  const cover = og.image && plat.cover ? plat.cover(og.image) : og.image;
  const aspect = plat.cover && cover !== og.image
    ? null                                   // 바꿔치기했으면 원본 비율은 의미가 없다
    : (og.imgW && og.imgH ? og.imgW / og.imgH : null);
  const cleaned = og.title ? stripSiteSuffix(og.title, og.siteName, plat.name) : "";

  const generic = pageIsGeneric(og, p.listUrl, plat, cleaned);

  /* **없다고 확신할 수 있는 것만** 가려낸다.

     · notfound — 그쪽이 404·410 이라 했다
     · moved    — 깊은 주소를 물었는데 대문으로 튕겼다 (없는 작품 번호)
     · generic  — 받아오긴 했는데 그 작품 이야기가 아니라 대문 정보다

     403·429·5xx·시간 초과는 여기 넣지 않는다. 우리를 막았거나 그쪽이 잠깐 아픈 것이지
     페이지가 없는 것이 아니다 — CGV 가 403 을 주는데 사람은 멀쩡히 보고 온 페이지다. */
  const asked = (() => { try { return new URL(p.listUrl); } catch { return null; } })();
  const land = (() => { try { return og.landed ? new URL(og.landed) : null; } catch { return null; } })();
  const bare = (s: string) => s.replace(/\/+$/, "");       // 끝의 빗금은 뜻이 없다
  const wentHome = !!land && !!asked
    && bare(asked.pathname) !== ""                          // 애초에 대문을 물은 것이 아니고
    && (bare(land.pathname) === "" || bare(land.pathname) === "/index");  // 대문(에 준하는 곳)으로 갔다
  const dead: "notfound" | "moved" | "generic" | "nohost" | null =
    og.status === -1 ? "nohost"                              // 그런 도메인이 없다
      : og.status === 404 || og.status === 410 ? "notfound"
        : wentHome ? "moved"
          : (og.read && generic) ? "generic" : null;

  return {
    ok: true,
    dead,
    status: og.status,
    platform: { id: plat.id, name: plat.name, color: plat.color, fg: plat.fg, initial: plat.initial },
    seriesId: p.seriesId,
    title: generic ? "" : cleaned,
    /* 제 이야기를 하지 않는 페이지의 그림은 공용 로고다 — 작품마다 같은 그림이 붙느니
       없는 편이 낫다. 표지가 없으면 제목 첫 글자로 만든 그림이 대신 들어간다. */
    coverUrl: generic ? null : cover,
    coverAspect: aspect,
    listUrl: p.listUrl,
    appUrl: p.appUrl,
    // 글(블로그) 매체는 회차 개념이 없다 — 블로그 하나가 작품 하나이고,
    // 주소의 숫자는 회차가 아니라 글 번호다. 플랫폼 이름을 열거하지 않고 매체로 가른다.
    episode: plat.mediaType === "text" ? null : (p.episode ?? null),
    mediaType: plat.mediaType,
    schedule: { mode: "unknown", days: [], next: null, source: "auto" },
    origin: !og.read ? "blocked" : (generic || !cleaned ? "none" : "og"),
    note: p.note,
  };
}

/** 화면에 그대로 쓸 수 있는 한 줄 설명 */
export function originLabel(r: Extract<Resolved, { ok: true }>): string {
  if (r.origin === "og") return "페이지가 공개한 정보에서 가져왔습니다";
  /* 막힌 것을 "정보를 공개하지 않는다" 고 하면 사실이 아니다 — CGV처럼 제목도 표지도
     다 내걸어 두었는데 자동 접속만 막아 둔 곳이 있다. 원인을 바로 말해야 다음에 무엇을
     하면 되는지가 이어진다. */
  if (r.origin === "blocked")
    return `${r.platform.name}이(가) 자동 읽기를 막고 있어 직접 입력합니다`;
  return `${r.platform.name}이(가) 작품별 정보를 공개하지 않아 직접 입력합니다`;
}

// 직접 실행: node src/resolve.ts <url>
if (import.meta.filename === process.argv[1]) {
  const url = process.argv[2];
  if (!url) { console.error("사용법: node src/resolve.ts <url>"); process.exit(1); }
  console.log(JSON.stringify(await resolveUrl(url), null, 1));
}
