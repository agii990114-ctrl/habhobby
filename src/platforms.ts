/* 플랫폼 규칙 — 공유 URL을 시리즈 단위로 환원하고, 앱으로 되돌려보낼 주소를 만든다.
   플랫폼을 늘리는 일이 코드가 아니라 이 배열에 한 줄 더하는 일로 남아야 한다.

   여기서 하는 일은 전부 문자열 처리다 — 네트워크를 쓰지 않는다.
   제목·표지는 Open Graph 태그로만 얻고(resolve.ts), 연재 일정은 사용자가 정한다.
   플랫폼의 비공개 내부 엔드포인트는 쓰지 않는다. */

export type Parsed = {
  seriesId: string;
  listUrl: string;
  appUrl: string | null;
  episode?: string | null;
  note?: string;
};

export type Platform = {
  id: string;
  name: string;
  color: string;
  fg: string;
  initial: string;
  mediaType: string;
  hosts: string[];
  parse(u: URL, host: string): Parsed | null;
};

export const DOMAIN_PREFIX = "domain:";

/* 국가 도메인 아래의 행정용 2단 접미사.

   "마지막 조각이 최상위 도메인"이라는 규칙은 어디서나 참이므로(TLD에는 점이 없다)
   따로 목록을 둘 필요가 없다. 목록이 필요한 건 co.kr·co.uk 처럼 조각이 둘인 경우뿐이다.

   Public Suffix List 전체(1만 규칙, 324KB)를 들이지 않은 이유는 갱신하지 않으면 조용히
   틀리는 카탈로그가 되기 때문이다. 여기 없는 접미사를 만나면 한 칸 덜 묶을 뿐이고,
   그때는 주소가 조금 길게 보일 뿐 기능이 깨지지는 않는다.

   호스팅 접미사(github.io·blogspot.com 등)는 일부러 넣지 않는다 — 티스토리를 한 단락으로
   모으는 것과 같은 이유로, 그런 곳의 하위 도메인은 한 묶음으로 보는 편이 낫다. */
const MULTI_SUFFIXES = new Set([
  "co.kr", "or.kr", "ne.kr", "go.kr", "re.kr", "pe.kr", "ac.kr", "sc.kr", "hs.kr", "ms.kr", "es.kr", "mil.kr",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "lg.jp", "ad.jp", "ed.jp", "gr.jp",
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "net.uk", "sch.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au", "asn.au",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn",
  "com.tw", "net.tw", "org.tw", "idv.tw", "gov.tw", "edu.tw",
  "com.hk", "net.hk", "org.hk", "edu.hk", "gov.hk", "idv.hk",
  "co.in", "net.in", "org.in", "ac.in", "edu.in", "gov.in", "firm.in", "gen.in", "ind.in",
  "com.br", "net.br", "org.br", "gov.br", "edu.br",
  "com.mx", "org.mx", "net.mx", "edu.mx", "gob.mx",
  "com.ru", "net.ru", "org.ru", "msk.ru", "spb.ru",
  "co.za", "org.za", "net.za", "ac.za", "gov.za",
  "co.nz", "net.nz", "org.nz", "ac.nz", "govt.nz", "school.nz",
  "com.sg", "net.sg", "org.sg", "edu.sg", "gov.sg",
  "co.il", "org.il", "net.il", "ac.il", "gov.il",
  "com.tr", "net.tr", "org.tr", "gov.tr", "edu.tr",
  "co.id", "or.id", "ac.id", "go.id", "web.id", "my.id",
  "co.th", "in.th", "ac.th", "go.th", "or.th",
  "com.vn", "net.vn", "org.vn", "edu.vn", "gov.vn",
  "com.ua", "net.ua", "org.ua", "kiev.ua",
  "com.pl", "net.pl", "org.pl", "edu.pl", "gov.pl",
  "com.es", "org.es", "nom.es", "gob.es", "edu.es",
  "com.ar", "net.ar", "org.ar", "gob.ar", "edu.ar",
  "com.ph", "net.ph", "org.ph", "edu.ph", "gov.ph",
  "com.my", "net.my", "org.my", "edu.my", "gov.my",
]);

/** 등록 단위 도메인. ko.wikipedia.org → wikipedia.org, a.brunch.co.kr → brunch.co.kr.

    구간을 나누는 데는 쓰지 않는다(호스트가 곧 구간이다). 사이트 이름을 고를 때
    "brunch.co.kr 의 핵심 낱말은 brunch" 를 알아내는 데만 쓴다. */
export function registrableDomain(host: string): string {
  const l = host.replace(/\.+$/, "").split(".").filter(Boolean);   // 끝점 제거
  if (l.length <= 2) return l.join(".");
  // IPv4 주소는 자를 대상이 아니다
  if (l.length === 4 && l.every(x => /^\d{1,3}$/.test(x))) return l.join(".");
  const two = l.slice(-2).join(".");
  return MULTI_SUFFIXES.has(two) ? l.slice(-3).join(".") : two;
}
export const DOMAIN_DEFAULT_COLOR = "#655A61";

/** 배경색 위에서 읽히는 글자색 — 임계값이 아니라 흑·백 대비비를 재서 고른다. */
export function readableOn(hex: string): string {
  const h = hex.replace("#", "");
  const lin = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? "#1B1B1B" : "#FFFFFF";
}

export const PLATFORMS: Platform[] = [
  {
    /* 주소 없이 제목만으로 담는 항목. 개봉을 기다리는 영화처럼 아직 페이지가 없거나,
       페이지를 찾아 붙일 만큼 중요하지 않은 것들이 여기 모인다.
       hosts가 비어 있어 어떤 주소에도 걸리지 않는다 — 오직 직접 만들 때만 쓰인다. */
    id: "note", name: "직접 입력", color: "#5C5470", fg: "#fff", initial: "✎",
    mediaType: "link", hosts: [], parse: () => null,
  },
  {
    id: "naver-webtoon", name: "네이버웹툰", color: "#03C75A", fg: "#fff", initial: "N",
    mediaType: "webtoon", hosts: ["comic.naver.com"],
    parse(u) {
      const id = u.searchParams.get("titleId");
      if (!id) return null;
      return {
        seriesId: id, episode: u.searchParams.get("no"),
        listUrl: `https://comic.naver.com/webtoon/list?titleId=${id}`,
        // 앱 스킴은 네이버가 자기 모바일 페이지(m.comic.naver.com)에서 쓰는 것을 그대로 쓴다 —
        // 짐작으로 적었던 naverwebtoon:// 은 열리지 않는 주소였다.
        appUrl: `webtoonkr://contentList?version=2&league=WEBTOON&titleId=${id}`,
      };
    },
  },
  {
    id: "kakao-webtoon", name: "카카오웹툰", color: "#1B1B1B", fg: "#fff", initial: "W",
    mediaType: "webtoon", hosts: ["webtoon.kakao.com"],
    parse(u) {
      const m = u.pathname.match(/^\/content\/([^/]+)\/(\d+)/);
      if (!m) return null;
      return {
        seriesId: m[2], episode: null,
        listUrl: `https://webtoon.kakao.com/content/${m[1]}/${m[2]}`,
        appUrl: `kakaowebtoon://content/${m[2]}`,
      };
    },
  },
  {
    id: "naver-series", name: "네이버시리즈", color: "#0F8C3B", fg: "#fff", initial: "S",
    mediaType: "novel", hosts: ["series.naver.com"],
    parse(u) {
      const id = u.searchParams.get("productNo");
      if (!id) return null;
      return {
        seriesId: id, episode: null,
        listUrl: `https://series.naver.com/comic/detail.series?productNo=${id}`,
        appUrl: `naverseries://detail?productNo=${id}`,
      };
    },
  },
  {
    id: "kakao-page", name: "카카오페이지", color: "#FFCD00", fg: "#1B1B1B", initial: "K",
    mediaType: "webtoon", hosts: ["page.kakao.com"],
    parse(u) {
      const m = u.pathname.match(/^\/content\/(\d+)(?:\/viewer\/(\d+))?/);
      if (!m) return null;
      return {
        seriesId: m[1], episode: null,
        listUrl: `https://page.kakao.com/content/${m[1]}`,
        appUrl: `kakaopage://open?path=content&id=${m[1]}`,
        note: "카카오페이지는 제목·표지·일정을 자동으로 얻을 수 없습니다. 직접 입력해 주세요.",
      };
    },
  },
  {
    id: "netflix", name: "넷플릭스", color: "#E50914", fg: "#fff", initial: "N",
    mediaType: "video", hosts: ["netflix.com"],
    parse(u) {
      let m = u.pathname.match(/\/title\/(\d+)/);
      if (m) return {
        seriesId: m[1], episode: null,
        listUrl: `https://www.netflix.com/title/${m[1]}`,
        appUrl: `nflx://www.netflix.com/title/${m[1]}`,
      };
      m = u.pathname.match(/\/watch\/(\d+)/);
      if (m) return {
        seriesId: m[1], episode: null,
        listUrl: `https://www.netflix.com/watch/${m[1]}`,
        appUrl: `nflx://www.netflix.com/watch/${m[1]}`,
        note: "에피소드 주소라 시리즈를 역산할 수 없습니다.",
      };
      return null;
    },
  },
  {
    id: "laftel", name: "라프텔", color: "#6C47FF", fg: "#fff", initial: "L",
    mediaType: "anime", hosts: ["laftel.net"],
    parse(u) {
      let m = u.pathname.match(/^\/item\/(\d+)/);
      if (m) return {
        seriesId: m[1], episode: null,
        listUrl: `https://laftel.net/item/${m[1]}`, appUrl: `laftel://item/${m[1]}`,
      };
      m = u.pathname.match(/^\/player\/(\d+)\/(\d+)/);
      if (m) return {
        seriesId: m[1], episode: m[2],
        listUrl: `https://laftel.net/item/${m[1]}`, appUrl: `laftel://item/${m[1]}`,
      };
      return null;
    },
  },
  {
    id: "naver-blog", name: "네이버 블로그", color: "#03C75A", fg: "#fff", initial: "B",
    mediaType: "text", hosts: ["blog.naver.com"],
    parse(u, host) {
      let blogId = u.searchParams.get("blogId");
      let logNo = u.searchParams.get("logNo");
      if (!blogId) {
        /* **경로 첫 조각이 늘 사람 아이디인 것은 아니다.**

           section.blog.naver.com 은 블로그가 아니라 **블로그를 모아 보는 곳**이고,
           그 경로에 오는 BlogHome.naver · PostList.naver 는 네이버가 붙인 페이지 이름이다.
           그것을 아이디로 읽으면 blog.naver.com/BlogHome.naver 라는 없는 주소가 만들어져
           404 가 났다 — 「자동 읽기가 안 된다」의 정체다.

           여기서 null 을 내면 소속은 네이버 블로그로 남고 주소는 손대지 않는다
           (parseShared 의 matched: false). 그다음은 여느 페이지처럼 읽어 본다. */
        if (host === "section.blog.naver.com") return null;
        const m = u.pathname.match(/^\/([^/]+)(?:\/(\d+))?/);
        if (!m) return null;
        // .naver 로 끝나는 조각은 페이지 이름이다 (PostView.naver 처럼) — 아이디가 아니다
        if (/\.naver$/i.test(m[1])) return null;
        blogId = m[1]; logNo = logNo ?? m[2] ?? null;
      }
      return {
        seriesId: blogId, episode: logNo,
        listUrl: `https://blog.naver.com/${blogId}`,
        appUrl: `naversearchapp://inappbrowser?url=https://blog.naver.com/${blogId}`,
      };
    },
  },
  {
    id: "ridi", name: "리디", color: "#1F8CE6", fg: "#fff", initial: "R",
    mediaType: "novel", hosts: ["ridibooks.com"],
    parse(u) {
      const m = u.pathname.match(/\/books\/(\d+)/);
      if (!m) return null;
      return {
        seriesId: m[1], episode: null,
        listUrl: `https://ridibooks.com/books/${m[1]}`,
        appUrl: `ridibooks://books/${m[1]}`,
      };
    },
  },
  {
    // 레진은 OG로 1200x600 가로 배너(wide.jpg)만 내놓는데, 같은 경로에 600x800
    // 세로 표지(tall.jpg)가 있다. 표지 칸이 3:4라 세로 쪽이 맞다.
    id: "lezhin", name: "레진코믹스", color: "#E5231B", fg: "#fff", initial: "레",
    mediaType: "webtoon", hosts: ["lezhin.com"],
    parse(u) {
      const m = u.pathname.match(/^\/[a-z]{2}\/comic\/([^/?#]+)/);
      if (!m) return null;
      return {
        seriesId: m[1], episode: null,
        listUrl: `https://www.lezhin.com/ko/comic/${m[1]}`,
        appUrl: null,
      };
    },
    cover: (img) => img.replace(/\/wide\.jpg/, "/tall.jpg"),
  },
  {
    // 네이버 블로그와 같은 방식 — 블로그 하나가 작품 하나이고, 전부 한 단락에 모인다.
    // 글 하나하나가 아니라 "내가 구독하는 블로그"가 담기는 단위다.
    id: "tistory", name: "티스토리", color: "#EB531F", fg: "#fff", initial: "티",
    mediaType: "text", hosts: ["tistory.com"],
    parse(u, host) {
      const m = host.match(/^([^.]+)\.tistory\.com$/);
      if (!m) return null;                       // tistory.com 자체는 블로그가 아니다
      const blogId = m[1];
      const post = u.pathname.match(/^\/(?:entry\/)?(.+)$/);
      return {
        seriesId: blogId,
        episode: post ? decodeURIComponent(post[1]).slice(0, 40) : null,
        listUrl: `https://${blogId}.tistory.com/`,
        appUrl: null,                            // 확인된 앱 스킴이 없어 웹으로 연다
      };
    },
  },
  {
    id: "tving", name: "티빙", color: "#FF153C", fg: "#fff", initial: "T",
    mediaType: "video", hosts: ["tving.com"],
    parse(u) {
      const m = u.pathname.match(/\/contents\/([A-Za-z0-9]+)/);
      if (!m) return null;
      return {
        seriesId: m[1], episode: null,
        listUrl: `https://www.tving.com/contents/${m[1]}`,
        appUrl: `tving://contents/${m[1]}`,
      };
    },
  },
];

/** 규칙 없는 도메인 — 이름을 붙이기 전에는 주소 자체가 이름이다. */
export function domainPlatform(host: string): Platform {
  return {
    id: DOMAIN_PREFIX + host, name: host, color: DOMAIN_DEFAULT_COLOR,
    fg: readableOn(DOMAIN_DEFAULT_COLOR), initial: "?", mediaType: "link",
    hosts: [host], parse: () => null,
  };
}

export function platformById(id: string): Platform {
  if (id.startsWith(DOMAIN_PREFIX)) return domainPlatform(id.slice(DOMAIN_PREFIX.length));
  return PLATFORMS.find(p => p.id === id) ?? domainPlatform("unknown");
}

export type ParseResult =
  | { ok: false; reason: string }
  | { ok: true; platform: Platform; matched: boolean } & Parsed;

/** 공유받은 문자열 → 플랫폼과 시리즈. 저장되는 URL은 항상 스킴을 포함한 절대 주소다. */
/** 문장 속에서 주소만 골라낸다.

    공유 버튼이 주소만 보내주지 않는다 — 네이버웹툰은
    "[네이버 웹툰] 청부입학
https://naver.me/G9UVxdoU" 처럼 제목까지 함께 보낸다.
    사람이 대화창에서 긁어 붙일 때도 앞뒤 말이 딸려온다. */
export function extractUrl(raw: string): string {
  const text = (raw ?? "").trim();
  const m = text.match(/https?:\/\/[^\s<>"'“”]+/i);
  if (!m) return text;                       // 스킴 없이 도메인만 친 경우를 위해 원문을 넘긴다
  // 문장 끝에 붙은 마침표·따옴표는 주소가 아니다. 괄호는 주소에 실제로 쓰이므로 두 손 뗀다.
  return m[0].replace(/["'“”.,;:!?]+$/, "");
}

export function parseShared(raw: string): ParseResult {
  const text = extractUrl(raw);
  if (!text) return { ok: false, reason: "주소가 비어 있습니다." };

  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.\-]*:/i.test(text) ? text : "https://" + text);
  } catch {
    return { ok: false, reason: "URL 형식으로 읽을 수 없습니다." };
  }
  // javascript:, data: 같은 주소가 링크로 저장되면 여는 순간 문제가 된다
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return { ok: false, reason: `http 또는 https 주소만 등록할 수 있습니다 (${u.protocol})` };
  if (!u.hostname.includes("."))
    return { ok: false, reason: "도메인이 없는 주소입니다." };

  const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");

  for (const p of PLATFORMS) {
    if (!p.hosts.some(h => host === h || host.endsWith("." + h))) continue;
    const r = p.parse(u, host);
    if (r) return { ok: true, platform: p, matched: true, ...r };
    // 경로가 규칙에 안 맞아도 사이트는 그 사이트다. 플랫폼을 바꾸면 같은 사이트가
    // 홈에서 두 단락으로 쪼개진다 — 시리즈 환원만 포기하고 소속은 유지한다.
    return {
      ok: true, platform: p, matched: false,
      seriesId: u.href, listUrl: u.href, appUrl: null,
      note: `${p.name}의 주소이지만 작품 페이지 형태가 아니라 링크로 저장합니다.`,
    };
  }

  /* 호스트 하나가 구간 하나다. music.apple.com 과 book.apple.com 은 따로 남는다 —
     자동으로 합치면 어느 쪽 이름이 잡힐지 넣는 순서에 달리게 되고, 사이트가 밝히는
     이름도 그 호스트의 것이라 기준이 어긋난다. 합치는 판단은 사용자가 이름으로 한다. */
  return {
    ok: true, platform: domainPlatform(host), matched: false,
    seriesId: u.href, listUrl: u.href, appUrl: null,
  };
}

/** 단축 URL은 서버가 리다이렉트를 한 번 따라가야 원본이 나온다. */
const SHORTENERS = ["naver.me", "kko.kakao.com", "kakao.link", "bit.ly", "tv.naver.me"];
export const isShortener = (raw: string): boolean => {
  try {
    const h = new URL(/^https?:/i.test(raw) ? raw : "https://" + raw).hostname.replace(/^www\./, "");
    return SHORTENERS.some(s => h === s || h.endsWith("." + s));
  } catch { return false; }
};
