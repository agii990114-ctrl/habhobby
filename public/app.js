/* HabHobby 클라이언트.
   상태는 서버가 진실이고, 화면은 서버 응답을 그대로 다시 그린다.
   모든 변경은 API를 거친 뒤 로컬 상태에 반영된다 — localStorage 없음. */
"use strict";

/* ── API ─────────────────────────────────────────────────── */
/* 서버와 이야기하는 유일한 창구.
   몸통이 그림 같은 파일(Blob)이면 그대로 보내고, 아니면 JSON 으로 바꿔 보낸다. */
async function api(method, path, body) {
  const raw = body instanceof Blob;
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": raw ? body.type : "application/json" } : undefined,
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.reason || `요청 실패 (${res.status})`);
  return data;
}

/* ── 상태 ────────────────────────────────────────────────── */
let works = [], folders = [], settings = { openMode: "app" }, platforms = {}, me = null;
/* 친구 목록은 첫 화면에 실려 오지 않는다 — null 이면 아직 안 불러온 것이다.
   쓰는 곳은 폴더 탭의 "친구 폴더 보기" 와 사이드 메뉴뿐이라, 캘린더만 보고 나가는
   사람에게는 200명분 17KB가 그냥 버려진다. 사이드 메뉴에 적을 숫자만 미리 받는다. */
let friends = null, friendCount = 0;
/** 받은 폴더 초대. 첫 화면에 함께 실려 온다 — 대개 비어 있어 무게가 없다. */
let folderInvites = [];
/* 끊겼다는 소식. 새로 고칠 때 함께 실려 온다 — 웹소켓을 붙들고 있을 만큼 급한 소식이
   아니고, 늘 이어 두면 그것대로 값이 든다. */
let folderNotices = [];
let tab = "cal", filter = "all", openFolderId = null;   // 들어오면 캘린더부터 보인다
/* 폴더 탭은 내 폴더 아니면 친구의 공개 폴더를 보여 준다.
   null 이면 내 것. 친구 것을 볼 때는 그 친구가 준 화면을 통째로 들고 있는다
   ({ id, name, folders, works, platforms }) — 내 자료와 섞이면 안 된다.
   주소에는 남기지 않는다. 새로 고치면 늘 내 폴더로 돌아온다. */
let viewing = null;
/* 캘린더 보기 상태 — 화면 설정이라 서버에 저장하지 않는다 */
let calView = "week";      // "week" | "month"
let calMonth = null;       // 월간에서 보고 있는 달(1일 자정). null이면 이번 달
let calDay = null;         // 월간에서 고른 날. null이면 오늘 또는 1일

let siteNamesPending = 0;

/** `fresh` 는 **앱을 새로 열 때 한 번**이다 — 지난번에 읽어 둔 소식을 걷고 나서 값을 준다.

    걷는 일을 따로 부르지 않고 이 길에 얹는 이유가 둘 있다. 하나는 왕복이 하나 더 늘면
    첫 화면이 그만큼 늦어지고, 다른 하나는 순서다 — 나중에 걷으면 방금 받아 온 목록에는
    걷힌 것이 그대로 남아, 새로 고쳤는데 안 없어진 것처럼 보인다. */
async function reload(fresh = false) {
  const s = await api("GET", "/api/state" + (fresh ? "?fresh=1" : ""));
  works = s.works; folders = s.folders; settings = s.settings;
  platforms = s.platforms; me = s.me;
  friendCount = s.friendCount ?? 0;
  folderInvites = s.folderInvites ?? [];
  folderNotices = s.folderNotices ?? [];
  friends = null;              // 친구가 바뀌었을 수 있다 — 다음에 열 때 새로 부른다
  siteNamesPending = s.siteNamesPending ?? 0;
  applyTheme(settings.themeColor);
}

/** 친구 목록을 (아직 없으면) 불러온다. 한 번 부르면 다음 reload() 까지 들고 있는다. */
async function loadFriends() {
  if (guestMode()) return (friends = []);
  if (!friends) friends = (await api("GET", "/api/friends")).friends;
  return friends;
}

/* 별 켠 사람이 위, 그다음은 나중에 친구가 된 순. 서버가 주는 순서와 같은 규칙이라
   별을 껐다 켠 뒤에도 다시 부르지 않고 제자리를 찾는다. */
const sortFriends = () => friends.sort((a, b) =>
  (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || b.since - a.since);

/* 이름을 첫소리로 가른다. 한글 열넷에 로마자와 숫자를 뒤에 붙인다 —
   표시 이름은 사람이 직접 정하는 것이라 무엇이든 올 수 있다. */
const CHO = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ",
             "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
/* 쌍자음은 제 홑자음 칸에 함께 넣는다 — ㄲ 만 있는 목록에서 ㄱ 을 눌렀는데 아무 데도
   안 가면 고장으로 보인다. 사람이 찾을 때 떠올리는 것은 ㄱ 이다. */
const CHO_FOLD = { "ㄲ": "ㄱ", "ㄸ": "ㄷ", "ㅃ": "ㅂ", "ㅆ": "ㅅ", "ㅉ": "ㅈ" };
const INDEX_KEYS = ["ㄱ", "ㄴ", "ㄷ", "ㄹ", "ㅁ", "ㅂ", "ㅅ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ", "A", "#"];

/** 그 이름이 어느 칸에 드는지 */
function initialOf(name) {
  const c = (name ?? "").trim().charCodeAt(0);
  if (Number.isNaN(c)) return "#";
  if (c >= 0xac00 && c <= 0xd7a3) {                 // 한글 음절
    const k = CHO[Math.floor((c - 0xac00) / 588)];
    return CHO_FOLD[k] ?? k;
  }
  if (c >= 0x3131 && c <= 0x314e) {                 // 홀자음만 쓴 이름
    const k = String.fromCharCode(c);
    return CHO.includes(k) ? (CHO_FOLD[k] ?? k) : "#";
  }
  const ch = String.fromCharCode(c).toUpperCase();
  return ch >= "A" && ch <= "Z" ? "A" : "#";        // 로마자는 한 칸에 모은다
}

/** 첫소리 차례로 묶는다. 한글 → 로마자 → 그 밖. */
function byInitial(list) {
  const rank = k => { const i = INDEX_KEYS.indexOf(k); return i < 0 ? 99 : i; };
  const sorted = [...list].sort((a, b) =>
    rank(initialOf(a.displayName)) - rank(initialOf(b.displayName))
    || a.displayName.localeCompare(b.displayName, "ko"));
  const out = [];
  for (const f of sorted) {
    const k = initialOf(f.displayName);
    if (!out.length || out.at(-1).key !== k) out.push({ key: k, items: [] });
    out.at(-1).items.push(f);
  }
  return out;
}

/** 켜고 끈 별을 다시 칠한다.

    **두 가지를 함께 바꿔야 한다** — 눌린 표시(aria-pressed)는 색을 금색으로 바꾸고,
    아이콘의 on 은 속을 채운다. 색만 바꾸면 금색 빈 별이라는 어중간한 것이 남아, 다시
    그리기 전까지 켠 것인지 아닌지 알 수 없다. 실제로 친구 목록에서 그 탈이 났다.
    칠하는 자리가 셋(친구 줄·폴더 줄·폴더 창)이라 한 곳으로 모은다. */
const paintStar = (btn, on) => {
  btn.setAttribute("aria-pressed", !!on);
  btn.innerHTML = icon("star", on ? "on" : "");
};

/** 별을 뒤집는다 — 켜짐과 **켠 때**를 함께 바꾼다.

    켠 때를 같이 안 바꾸면, 즐겨찾기 창이 켠 차례대로 세우는데 방금 켠 것만 차례가
    없어 엉뚱한 자리에 선다. 서버가 답하기 전에 화면을 먼저 그리므로 여기서 미리 채운다.
    되돌릴 때는 다시 이 함수를 부르면 된다. */
const flipStar = f => {
  f.starred = !f.starred;
  f.starredAt = f.starred ? Date.now() : 0;
  return f.starred;
};

/** 별 하나 — 친구 목록에서 쓴다 */
const starHtml = f => `<button class="star" data-star="${esc(f.id)}"
  aria-pressed="${!!f.starred}" title="즐겨찾기"
  aria-label="${esc(f.displayName)} 즐겨찾기">${icon("star", f.starred ? "on" : "")}</button>`;

/* 도메인 구간의 이름을 사이트가 밝힌 og:site_name 으로 채운다.
   한 사이트당 한 번이면 되고, 못 얻으면 주소 그대로 둔다 — 있으면 좋은 것이지 없다고 못 쓸 것은 아니다. */
async function fillSiteNames() {
  while (siteNamesPending > 0) {
    let r;
    try { r = await api("POST", "/api/platforms/site-names"); } catch { return; }
    if (r.filled) { await reload(); render(); } else siteNamesPending = r.remaining;
    if (!r.remaining) return;
  }
}

const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const MEDIA = { webtoon: "웹툰", video: "영상", anime: "애니", novel: "웹소설", text: "글", link: "링크" };
const SCHED_LABEL = {
  weekly: "매주 연재", biweekly: "격주 연재", monthly: "매월 연재", "monthly-dow": "매월 연재",
  dated: "날짜 지정", always: "상시", done: "완결", hiatus: "휴재", unknown: "일정 미정",
};
const SCHED_MODES = [
  ["weekly", "매주"], ["biweekly", "격주"], ["monthly", "매월"],
  ["always", "상시"], ["dated", "날짜 지정"],
  ["done", "완결"], ["hiatus", "휴재"], ["unknown", "미정"],
];
/* days는 주기에 따라 뜻이 다르다 — 매주·격주는 요일(0~6), 매월은 날짜(1~31).
   한 칸을 나눠 쓰는 대신 모드를 갈아탈 때 비워서 섞이지 않게 한다. */
const daysKind = m => (m === "weekly" || m === "biweekly") ? "dow"
  : m === "monthly" ? "dom" : m === "monthly-dow" ? "ndow" : "";

/* "매월 둘째 화요일" 같은 표기. 주차(1~4, 5=마지막)와 요일(0~6)을 한 숫자에 담는다.
   요일이 8보다 작으므로 자리를 나눠 쓰면 서로 섞이지 않는다. */
const NTH = [[1, "첫째"], [2, "둘째"], [3, "셋째"], [4, "넷째"], [5, "마지막"]];
const packNth = (n, d) => (n << 3) | d;
const unpackNth = v => [v >> 3, v & 7];
const nthLabel = v => { const [n, d] = unpackNth(v);
  return `${NTH.find(x => x[0] === n)?.[1] ?? n} ${DOW[d]}요일`; };
const isMonthly = m => m === "monthly" || m === "monthly-dow";
const SCHED_HINT = {
  always: "한 번에 전부 공개된 작품. 넷플릭스 오리지널 시즌 전체 공개처럼 요일에 매이지 않는 것들입니다.",
  done: "연재가 끝난 작품. 상시와 함께 &ldquo;언제든&rdquo;에 모입니다.",
  hiatus: "쉬어가는 중. 캘린더의 &ldquo;일정 없음&rdquo;에 모입니다.",
  unknown: "일정을 모르는 상태. 캘린더의 &ldquo;일정 없음&rdquo;에 모입니다.",
};
const PROVIDER_LABEL = { kakao: "카카오", naver: "네이버", google: "Google",
  local: "이 기기", guest: "둘러보기", password: "아이디 로그인" };
/* ── 붙박이 아이콘 ────────────────────────────────────────
   한때 이 자리들이 전부 이모지였다. 그런데 이모지는 **기기가 그린다** — 윈도우의 🔔과
   아이폰의 🔔이 서로 다른 그림이고, 크기도 굵기도 글줄 위 높이도 제각각이라 버튼마다
   따로 맞춰야 했다.

   그렇다고 아이콘 글꼴(폰트어썸 같은)을 부르지는 않는다. 쓰는 것은 열몇 개인데 세트
   하나가 수천 개분 글리프를 싣고 오고, 무엇보다 **바깥으로 요청이 하나 는다** — 이 앱은
   의존성이 없고 화면 파일을 한 번에 내보내는 것이 값의 대부분이다.

   그래서 필요한 것만 여기 그려 둔다. 다 합쳐 2KB 남짓이고, currentColor 를 따르므로
   글자 빛깔이 그대로 온다. **사용자가 고르는 폴더 이모지는 그대로 둔다** — 그건 우리
   그림이 아니라 그 사람이 고른 표식이다. */
/* 그림 조각들.

   **껍데기(index.html)에는 같은 그림이 인라인으로 한 번 더 있다.** 화면 맨 위 줄과
   서랍은 app.js 가 내려오기 전에 이미 보여야 해서, 그것만은 HTML 에 직접 그려 둔다.
   그래서 아래 일곱은 두 곳에 같은 모양이 있다 — search · cog · plus · users · x ·
   check · trash. **한쪽만 고치면 조용히 어긋난다** (톱니로 바꿀 때 실제로 두 곳을
   고쳤다). 여기 것을 고치거든 index.html 도 함께 보라.

   껍데기에만 있고 여기는 없는 것도 있다(☰ · 종 · 편지 · 게시판) — 여기 두어 봐야
   부르는 이가 없어 무게만 는다. */
const ICONS = {
  // 「전체 목록」 — 줄 앞에 점을 찍어 그냥 메뉴와 갈린다
  list:    `<path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12"/><path d="M4 6.5h.01M4 12h.01M4 17.5h.01"/>`,
  search:  `<circle cx="11" cy="11" r="6.8"/><path d="M20 20l-4.2-4.2"/>`,
  /* 설정 — 톱니바퀴. 한때 「톱니는 작게 그리면 뭉개진다」며 손잡이 세 줄을 썼는데,
     그건 그리기 나름이었다. 이빨을 여덟 개만 두고 뿌리(7.0)와 끝(9.4)의 차를 크게
     잡으면 1.25em 에서도 이빨이 하나씩 세어진다. 가운데 구멍은 3.1 — 더 줄이면
     선 굵기에 먹혀 사라진다. */
  cog:     `<path d="M10.01 5.29L10.21 2.77L13.79 2.77L13.99 5.29A7 7 0 0 1 15.34 5.85L17.26 4.21L19.79 6.74L18.15 8.66A7 7 0 0 1 18.71 10.01L21.23 10.21L21.23 13.79L18.71 13.99A7 7 0 0 1 18.15 15.34L19.79 17.26L17.26 19.79L15.34 18.15A7 7 0 0 1 13.99 18.71L13.79 21.23L10.21 21.23L10.01 18.71A7 7 0 0 1 8.66 18.15L6.74 19.79L4.21 17.26L5.85 15.34A7 7 0 0 1 5.29 13.99L2.77 13.79L2.77 10.21L5.29 10.01A7 7 0 0 1 5.85 8.66L4.21 6.74L6.74 4.21L8.66 5.85A7 7 0 0 1 10.01 5.29Z"/><circle cx="12" cy="12" r="3.1"/>`,
  plus:    `<path d="M12 5.2v13.6M5.2 12h13.6"/>`,
  // 추가 목록 — 집게 달린 판
  // 폴더 초대 — 봉투
  users:   `<circle cx="9.2" cy="8" r="3.4"/><path d="M3 20c0-3.4 2.8-5.5 6.2-5.5s6.2 2.1 6.2 5.5"/><path d="M16 5.2a3.4 3.4 0 0 1 0 6.6"/><path d="M17.6 15c2.1.7 3.4 2.4 3.4 5"/>`,
  x:       `<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`,
  pencil:  `<path d="M4 20h4L18.4 9.6a2.4 2.4 0 0 0-3.4-3.4L4.6 16.6z"/><path d="M14.4 7.4l2.6 2.6"/>`,
  star:    `<path d="M12 3.6l2.7 5.5 6 .9-4.35 4.2 1.03 6-5.38-2.83L6.62 20.2l1.03-6L3.3 10l6-.9z"/>`,
  check:   `<path d="M4.8 12.6l4.8 4.8L19.2 6.9"/>`,
  trash:   `<path d="M3.8 6.8h16.4"/><path d="M9.4 6.8V5A1.4 1.4 0 0 1 10.8 3.6h2.4A1.4 1.4 0 0 1 14.6 5v1.8"/><path d="M6.4 6.8l.95 12.3a2 2 0 0 0 2 1.85h5.3a2 2 0 0 0 2-1.85l.95-12.3"/><path d="M10.3 10.6v6.6M13.7 10.6v6.6"/>`,
  left:    `<path d="M14.8 5.2L8 12l6.8 6.8"/>`,
  right:   `<path d="M9.2 5.2L16 12l-6.8 6.8"/>`,
  // 「전체」 — 네 칸으로 나눈 판. 폴더가 아니라 **모두를 보는 길**이라 폴더처럼 안 그린다.
  grid:    `<rect x="3.4" y="3.4" width="7.4" height="7.4" rx="1.6"/><rect x="13.2" y="3.4" width="7.4" height="7.4" rx="1.6"/><rect x="3.4" y="13.2" width="7.4" height="7.4" rx="1.6"/><rect x="13.2" y="13.2" width="7.4" height="7.4" rx="1.6"/>`,
  // 폴더 줄 오른쪽의 ⋮ — 그 줄에 딸린 것을 더 여는 자리
  dots:    `<circle cx="12" cy="5.2" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="18.8" r="1.5"/>`,
  // 「미분류」 — 아직 안 갈라 놓은 것이 담기는 함
  inbox:   `<path d="M3 12.5h4.6l1.5 3h5.8l1.5-3H21"/><path d="M5 5.6L3 12.5v5.1a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5.1l-2-6.9a2 2 0 0 0-1.9-1.4H6.9A2 2 0 0 0 5 5.6z"/>`,
};

/** 아이콘 한 조각. 크기와 빛깔은 자리마다 CSS가 정한다. */
const icon = (name, cls = "") => ICONS[name]
  ? `<svg class="ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" aria-hidden="true"
      focusable="false">${ICONS[name]}</svg>`
  : "";

const STATES = {
  watched: { label: "감상 완료", icon: "check", desc: "끝까지 본 시리즈" },
  dropped: { label: "휴지통", icon: "trash", desc: "더 보지 않는 시리즈" },
};

const MAX_STAR = 5;
/* 별점은 **그린 별**로 적는다. ★☆ 는 글꼴이 그리는 것이라 기기마다 굵기가 달랐고,
   켠 것과 안 켠 것의 대비도 글꼴에 맡겨야 했다. 여기서는 안을 채우고 비우는 차이다. */
const starText = n => icon("star", "on").repeat(n) + icon("star").repeat(MAX_STAR - n);

/** 받침에 따라 "으로 / 로"를 고른다 — "휴지통으로", "감상 완료로" */
function ro(word) {
  const code = word.charCodeAt(word.length - 1) - 0xAC00;
  if (code < 0 || code > 11171) return "로";      // 한글이 아니면 기본형
  const jong = code % 28;
  return jong === 0 || jong === 8 ? "로" : "으로";  // 받침 없음, 또는 ㄹ받침
}

/* ── 테마 색 ──────────────────────────────────────────────
   고른 색 하나에서 --accent · --accent-ink · --accent-soft 를 만들어 낸다.

   명도(HSL의 L)는 눈에 보이는 밝기와 다르다 — 노랑은 파랑보다 훨씬 밝게 느껴져서,
   고정 명도를 쓰면 어떤 색에서는 글자가 안 읽힌다. 그래서 색상마다 대비를 재서
   4.5:1을 넘는 첫 명도를 찾는다. 색상환 전체(24색)에서 라이트·다크 모두 통과함을 확인했다. */
const THEME_TARGET = 4.5;
/** 기본 테마 — 흰 바탕에 주황 포인트 */
const THEME_DEFAULT = "#E8590C";

/* 바탕·선·글자도 고른 색을 아주 옅게 머금는다. 강조색만 바꾸면 회색들만 옛 색조로 남는다.
   [채도, 명도] 쌍이고, 색상환 24색에서 대비를 재어 정한 값이다. */
const NEUTRALS = {
  light: { "--bg": [16, 98.5], "--surface": [0, 100], "--surface-2": [15, 96], "--surface-3": [14, 92],
           "--line": [14, 91], "--line-2": [13, 84],
           "--ink": [10, 12], "--ink-2": [7, 34], "--ink-3": [6, 41] },
  dark:  { "--bg": [12, 7], "--surface": [11, 11], "--surface-2": [10, 16], "--surface-3": [10, 21],
           "--line": [10, 22], "--line-2": [9, 30],
           "--ink": [8, 95], "--ink-2": [6, 74], "--ink-3": [6, 59] },
};

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [Math.round(h), Math.round(sat * 100), Math.round(l * 100)];
}

const hslRgb = (h, s, l) => {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l), k = n => (n + h / 30) % 12;
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map(v => Math.round(255 * v));
};
const relLum = ([r, g, b]) => {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const [x, y] = [relLum(a), relLum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** 배경에서 멀어지며 목표 대비를 처음 넘는 명도 */
function inkLightness(h, sat, bg, dark) {
  for (let i = 0; i <= 100; i++) {
    const l = dark ? 45 + i : 55 - i;
    if (l < 0 || l > 100) break;
    if (contrast(hslRgb(h, sat, l), bg) >= THEME_TARGET) return l;
  }
  return dark ? 92 : 12;
}
/** 바탕으로 쓰이는 색 — 흑·백 중 나은 쪽이 목표를 넘을 때까지 어둡게 */
function accentLightness(h, sat, from) {
  for (let l = from; l >= 8; l--) {
    const c = hslRgb(h, sat, l);
    if (Math.max(contrast(c, [255, 255, 255]), contrast(c, [27, 27, 27])) >= THEME_TARGET) return l;
  }
  return 8;
}

/* 시스템 설정이 아니라 문서에 적힌 값을 본다. 지금은 index.html 이 항상 light 로 못 박아
   두었으므로 늘 밝은 화면이다 — 시스템이 다크여도 따라가지 않는다. */
const isDarkMode = () => document.documentElement.dataset.theme === "dark";

/** 화면에 얹은 값을 그대로 담아 둔다 — index.html 의 첫 줄 스크립트가 이걸 되살려
    설정을 받아 오기 전의 기본색 번쩍임을 없앤다. 계산은 여기 한 곳에만 있다. */
const THEME_CACHE = "hh-theme";

function applyTheme(hex) {
  const root = document.documentElement.style;
  const meta = document.querySelector('meta[name="theme-color"]');
  const kept = {};
  const [h, s0, l0] = hexToHsl(hex || THEME_DEFAULT);
  /* 너무 흐린 색은 강조가 안 되고 너무 쨍하면 눈이 아프다 — 가운데로 모은다.
     다만 회색·검정처럼 색이 아예 없는 값은 그대로 둔다. 끌어올리면 색상 0(빨강)이 튀어나온다. */
  const sat = s0 < 12 ? s0 : Math.min(88, Math.max(35, s0));
  const dark = isDarkMode();
  // 글자색은 좀 더 진하게 쓰되, 무채색을 골랐으면 글자색도 무채색이어야 한다
  const inkSat = sat < 12 ? sat : (dark ? 80 : 90);
  const softSat = dark ? Math.min(sat, 26) : Math.min(sat, 70);
  const soft = dark ? hslRgb(h, softSat, 16) : hslRgb(h, softSat, 96);
  const ink = inkLightness(h, inkSat, soft, dark);
  /* 라이트에서는 고른 밝기를 되도록 지킨다 — 어두운 초록을 골랐는데 밝은 초록이 나오면
     고른 것 같지가 않다. 다만 대비가 모자라면 거기서부터 어둡게 내린다.
     다크에서는 고른 값이 어두우면 아예 안 보이므로 밝기를 통일한다. */
  const acc = dark ? 62 : accentLightness(h, sat, Math.min(58, Math.max(30, l0)));

  const set = (k, v) => { root.setProperty(k, v); kept[k] = v; };

  set("--accent", `hsl(${h} ${sat}% ${acc}%)`);
  set("--accent-ink", `hsl(${h} ${inkSat}% ${ink}%)`);
  set("--accent-soft", `hsl(${h} ${softSat}% ${dark ? 16 : 96}%)`);

  // 무채색을 골랐으면 바탕도 색기가 없어야 한다
  const tint = sat < 12 ? 0 : 1;
  for (const [k, [ns, nl]] of Object.entries(NEUTRALS[dark ? "dark" : "light"]))
    set(k, `hsl(${h} ${ns * tint}% ${nl}%)`);

  const bar = `hsl(${h} ${sat}% ${acc}%)`;
  if (meta) meta.content = bar;
  kept["theme-color"] = bar;

  // 사파리의 사생활 보호 창처럼 저장이 막힌 곳이 있다 — 안 되면 번쩍임만 남고 나머지는 그대로다
  try { localStorage.setItem(THEME_CACHE, JSON.stringify(kept)); } catch {}
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* 게스트 — 로그인 없이 바로 쓰는 계정. 기기에 남는 쿠키가 유일한 열쇠라
   친구 기능은 열지 않는다 (서버에서도 막는다). */
const guestMode = () => me?.provider === "guest";

/* 공개한 폴더를 친구가 **가져갈 수 있는가**. 보는 것과 가져가는 것은 다른 일이다.

   담아가기는 한 벌 떠 가는 것이라 그 뒤로 서로 상관이 없고, 미러링은 비추기만 해서
   내가 고치면 그쪽에도 바뀐다. 어느 쪽을 허락할지는 폴더마다 다를 수 있다 —
   "가져가서 네 맘대로 해" 와 "내가 고르는 걸 계속 봐" 는 다른 뜻이다. */
/* 폴더 설정은 **두 가지만 묻는다** — 누구에게 보일지, 그 사람이 무엇을 할 수 있는지.
   한때 「고른 친구와 함께 쓰기」를 공개 갈래에 끼워 두었는데, 그건 공개 대상과 퍼가기를
   한 항목에 뭉쳐 놓은 것이라 갈래가 셋인지 넷인지도 헷갈렸다. 함께 쓰기는 **퍼가기 쪽**
   이야기다 — 「폴더 공유」로 그리로 옮겼다. */
/* **「나만 보기」는 범위에 두지 않는다.** 공개 설정의 「비공개」가 이미 그 자리다 —
   같은 뜻이 두 곳에 있으면 어느 쪽을 눌러야 하는지 알 수 없고, 애초에 셋이 다 꺼져
   있으면 범위 칸이 뜨지도 않는다. 값 자체(none)는 남는다 — 저장될 때 그 모양이 필요하다. */
const SHARE_MODES = [
  ["all", "전체 공개", "친구가 늘어나면 그 사람에게도 보입니다."],
  ["some", "친구 선택", "고른 사람이 볼 수 있습니다."],
];
/* **켜고 끄는 셋.** 하나만 고르는 것이 아니라 원하는 만큼 켠다 — 클로닝과 미러링을
   함께 열어 두면 친구가 둘 중에 고른다. 셋을 다 끄면 비공개다. */
const TAKE_FLAGS = [
  ["copy", "클로닝", "한 벌 떠 갑니다. 그 뒤로는 내가 고쳐도 그쪽엔 안 갑니다."],
  ["mirror", "미러링", "내 폴더를 그대로 비춥니다. 내가 고치면 그쪽에도 바뀝니다."],
  ["edit", "쉐어링", "고른 사람에게 초대를 보냅니다. 수락하면 함께 넣고 뺍니다. 작품 자체는 넣은 사람만 고칩니다."],
];
/** 켜진 것들을 값으로 — 차례를 고정해 같은 조합이 늘 같은 글자가 되게 한다 */
const takeValue = set => TAKE_FLAGS.map(([v]) => v).filter(v => set.has(v)).join(",");
// 함께 고치는 사이라면 담아가는 것도 된다 — 가장 너그러운 갈래다
/* **셋은 서로 독립이다.** 클로닝 · 미러링 · 쉐어링을 따로 켜고 끈다. 값은 쉼표로 이은
   글자("copy,mirror")이고, 셋이 다 꺼져 있으면(빈 글자) 비공개다. */
const hasTake = (t, f) => String(t ?? "").split(",").includes(f);
const canCopy = t => hasTake(t, "copy");
const canMirror = t => hasTake(t, "mirror");
const canEdit = t => hasTake(t, "edit");

/** 이 **남의 작품**을 담아 올 수 있나.

    한 작품이 여러 폴더에 들어 있을 수 있다 — 친구가 「미러링만」인 폴더와 함께 쓰는
    폴더에 같은 작품을 넣어 두는 일은 흔하다. 서버는 그중 **하나라도** 담아가기를
    열어 뒀으면 담게 해 준다(takable). 화면이 줄에 적힌 mirrorTake 하나만 보면 서버보다
    인색해져, **담을 수 있는데 버튼이 안 뜨는** 자리가 생긴다. 같은 잣대로 가린다. */
const mayTakeWork = w => !!w.mirror && !!w.listUrl && w.folders.some(id => {
  const f = folders.find(x => x.id === id);
  return f && canCopy(f.mirrorTake ?? f.take);
});

const FALLBACK_PLATFORM = { name: "링크", color: "#655A61", fg: "#fff", initial: "?", isDomain: true };
const platformOf = id => platforms[id] ?? { ...FALLBACK_PLATFORM, id };

/* 함께 고치는 폴더에서 **남이 넣은 작품**은 그 폴더 안에서만 보인다(folderOnly).
   그 사람이 정한 일정이 내 캘린더를 채우면 내가 보기로 한 것과 뒤섞인다 —
   마음에 들면 「내 목록에 담기」로 한 번 눌러 내 것으로 만든다. */
const activeWorks = () => works.filter(w => w.state === "active" && !w.folderOnly);
/** 폴더 안을 볼 때만 쓰는 목록 — 남이 넣어 둔 것까지 포함한다 */
const filedWorks = () => works.filter(w => w.state === "active");
const worksInState = s => byRecent(works.filter(w => w.state === s));
const unfiled = () => byRecent(activeWorks().filter(w => !w.filed && !w.folders.length));

/** 이 작품이 든 폴더 이름들. 지워진 폴더의 자국은 걸러낸다 —
    작품의 folders 는 폴더가 사라져도 그 id 를 들고 있을 수 있다. */
const folderNames = w => w.folders
  .map(id => folders.find(f => f.id === id))
  .filter(Boolean)
  .map(f => (f.emoji ? f.emoji + " " : "") + f.name)
  .join(", ");
const byRecent = list => [...list].sort((a, b) => b.lastAt - a.lastAt);

/* 캘린더 점 색. 정해 두지 않았으면 플랫폼 색을 쓴다 —
   같은 플랫폼 작품이 여럿이면 달력에서 서로 구분이 안 되니 직접 고를 수 있게 한다. */
const workColor = w => w.color || platformOf(w.platformId).color;
function hue(str) { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
/* 표지 칸은 3:4 세로다. 그런데 OG 이미지는 링크 미리보기용이라 가로가 흔하다
   (유튜브 16:9, GitHub 2:1, 레진 배너 2:1). 가로 이미지를 cover 로 채우면 가운데
   좁은 띠만 확대돼 보이므로, 통째로 보이게 하고 뒤를 제목 색으로 채운다. */
const WIDE = 1.2;
function coverStyle(w) {
  const h = hue(w.title || "?");
  const back = `linear-gradient(150deg, hsl(${h} 58% 54%), hsl(${(h + 42) % 360} 52% 38%))`;
  if (!w.coverUrl) return `background:${back}`;
  const wide = w.coverAspect && w.coverAspect > WIDE;
  return `background-image:url(${esc(w.coverUrl)});background-repeat:no-repeat;`
    + `background-position:center;background-color:hsl(${h} 30% 22%);`
    + `background-size:${wide ? "contain" : "cover"}`;
}
const coverChar = w => (w.coverUrl ? "" : esc((w.title || "?").slice(0, 1)));

function ago(ts) {
  const m = (Date.now() - ts) / 6e4;
  if (m < 60) return "방금";
  if (m < 1440) return `${Math.floor(m / 60)}시간 전`;
  const d = m / 1440;
  if (d < 2) return "어제";
  if (d < 7) return `${Math.floor(d)}일 전`;
  return `${Math.floor(d / 7)}주 전`;
}

const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

/** 공개일까지 며칠 남았는지. 날짜끼리 재므로 시각은 보지 않는다 —
    오늘 밤 11시와 내일 새벽 1시는 두 시간 차이지만 "오늘" 과 "내일" 이다. */
function daysLeft(t) {
  const d = new Date(t); d.setHours(0, 0, 0, 0);
  const n = Math.round((d - midnight()) / 864e5);
  return n <= 0 ? "오늘" : n === 1 ? "내일" : `${n}일 뒤`;
}
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/** 그 날이 속한 주의 월요일 자정. 격주의 기준점을 주 단위로 맞추는 데 쓴다. */
function mondayOf(t) {
  const d = new Date(t); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** 이 일정이 적용되기 시작한 날(자정). 서버가 안 알려주면 등록일로 본다. */
function schedStart(w) {
  const d = new Date(w.schedule.from ?? w.addedAt);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 이 작품이 이 날에 놓이는가. 캘린더의 모든 칸이 이 하나를 거친다. */
/** 캘린더에 놓이는 마지막 날.

    감상 완료는 "언제부터 언제까지 보던 작품" 이라 그 기간을 기록으로 남긴다.
    휴지통은 관심이 없어진 것이라 남길 이유가 없다 — 아예 놓지 않는다. */
function schedEnd(w) {
  if (w.state === "active") return Infinity;
  if (w.state === "dropped") return -Infinity;
  const t = w.stateAt ?? w.lastAt;
  const d = new Date(t); d.setHours(23, 59, 59, 999);   // 그날까지는 보고 있었다
  return d.getTime();
}

function occursOn(w, date) {
  const s = w.schedule;
  // 반복 일정은 정하기 전 과거로 소급되지 않는다. 수요일 연재를 오늘 등록했다면
  // 지난 수요일들에 놓을 근거가 없다 — 그때는 목록에 있지도 않았다.
  if (["weekly", "biweekly", "monthly", "monthly-dow"].includes(s.mode) && date.getTime() < schedStart(w))
    return false;
  // 감상 완료·휴지통으로 내린 뒤로는 놓지 않는다. 그 전까지는 기록으로 남는다.
  if (date.getTime() > schedEnd(w)) return false;

  if (s.mode === "weekly") return s.days.includes(date.getDay());
  if (s.mode === "biweekly") {
    if (!s.days.includes(date.getDay())) return false;
    if (!s.next) return true;            // 기준이 없으면 매주로 본다 — 조용히 사라지는 편보다 낫다
    const weeks = Math.round((mondayOf(date) - mondayOf(s.next)) / (7 * 864e5));
    return (weeks % 2 + 2) % 2 === 0;
  }
  if (s.mode === "monthly") {
    // 31일 연재인데 2월이면 그 날이 없다. 건너뛰면 한 달이 통째로 비므로 말일로 당긴다.
    const lastDom = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    return s.days.some(n => Math.min(n, lastDom) === date.getDate());
  }
  if (s.mode === "monthly-dow") {
    const dom = date.getDate(), dow = date.getDay();
    const nth = Math.floor((dom - 1) / 7) + 1;   // 이 날은 그 달의 몇 번째 그 요일인가
    const lastDom = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    const isLast = dom + 7 > lastDom;            // 다음 주 같은 요일이 없으면 마지막이다
    return s.days.some(v => {
      const [n, d] = unpackNth(v);
      return d === dow && (n === 5 ? isLast : n === nth);
    });
  }
  if (s.mode === "dated") return !!s.next && sameDay(s.next, date);
  return false;
}

function schedText(w) {
  const s = w.schedule;
  const dow = () => [...s.days].sort().map(d => DOW[d]).join("·");
  if (s.mode === "weekly" && s.days.length) return `매주 ${dow()}요일`;
  if (s.mode === "biweekly" && s.days.length) return `격주 ${dow()}요일`;
  if (s.mode === "monthly" && s.days.length)
    return `매월 ${[...s.days].sort((a, b) => a - b).join("·")}일`;
  if (s.mode === "monthly-dow" && s.days.length)
    return `매월 ${[...s.days].sort((a, b) => a - b).map(nthLabel).join(", ")}`;
  if (s.mode === "dated" && s.next) {
    const d = new Date(s.next);
    return `${d.getMonth() + 1}/${d.getDate()} (${DOW[d.getDay()]})`;
  }
  return SCHED_LABEL[s.mode] ?? "일정 미정";
}

/* ── 화면 ────────────────────────────────────────────────── */
const screenEl = document.getElementById("screen");
const fabEl = document.getElementById("btn-inbox");
const idleEl = document.getElementById("btn-idle");
const fiEl = document.getElementById("btn-fi");
/* 좁은 화면에서는 문서가, 넓은 화면에서는 .screen 이 구른다 (styles.css 끝 참고).
   어느 쪽이든 같은 값을 읽을 수 있게 한 곳에 묶어 둔다. */
const narrow = () => matchMedia("(max-width: 700px)").matches;

/* 화면을 다 덮는 시트라도 상단바만은 남겨 둔다 — 지금 어느 화면에 있었는지가 보이고,
   그 자리를 눌러 닫을 수도 있다. 상단바 높이는 글꼴이 늦게 오면 달라지므로 재어 쓴다. */
{
  const bar = document.querySelector(".app-bar");   // 로그인 화면에는 없다
  const sync = () => { if (bar) document.documentElement.style
    .setProperty("--bar-h", `${Math.round(bar.getBoundingClientRect().height)}px`); };
  sync();
  addEventListener("resize", sync);
  addEventListener("resize", fitWeek);
  if (document.fonts?.ready) document.fonts.ready.then(sync);
}

const scrolledY = () => (narrow() ? window.scrollY : screenEl.scrollTop);
const toTop = () => { if (narrow()) window.scrollTo(0, 0); else screenEl.scrollTop = 0; };

let lastScrollY = 0;
/* 내려 읽는 동안 ＋ 버튼은 비켜난다.

   아이폰은 끝에서 더 당기면 화면을 고무줄처럼 튕긴다. 그 움직임은 그대로 두되
   (손맛이라 없애지 않는다), 되돌아오는 것이 "위로 올렸다"로 읽혀 숨겨 둔 버튼이 다시
   튀어나오는 것만 막는다 — 스크롤 값이 정상 범위를 벗어나 있으면 사람이 민 것이 아니다. */
const scrollMax = () => (narrow()
  ? document.documentElement.scrollHeight - innerHeight
  : screenEl.scrollHeight - screenEl.clientHeight);

const onScroll = () => {
  const y = scrolledY();
  if (y < 0 || y > scrollMax()) return;      // 튕기는 중 — 사람이 민 것이 아니다
  const d = y - lastScrollY;
  if (Math.abs(d) < 8) return;
  const tuck = d > 0 && y > 28;
  fabEl.classList.toggle("tucked", tuck);
  idleEl.classList.toggle("tucked", tuck);
  fiEl.classList.toggle("tucked", tuck);
  lastScrollY = y;
};
// 둘 중 하나만 실제로 구르므로 양쪽에 걸어 두어도 겹치지 않는다
screenEl.addEventListener("scroll", onScroll, { passive: true });
window.addEventListener("scroll", onScroll, { passive: true });

/* 시트가 열리자마자 입력칸에 커서를 넣던 것을 좁은 화면에서는 하지 않는다.

   아이폰에서 이것이 여러 탈을 냈다. 커서가 가면 키보드가 올라오고, 사파리는 그 칸을
   보여 주려고 **화면 전체를 밀어 올린다.** 그러고 나면 화면에 붙여 둔 것들(덮개 · ＋ 버튼)이
   그려진 자리와 눌리는 자리가 어긋나서, 버튼을 눌렀는데 뒤에 있는 목록이 눌렸다.
   창을 닫아도 그 어긋남이 남았다.

   넓은 화면에서는 그대로 넣는다 — 키보드가 없어서 탈이 날 일이 없고, 바로 칠 수 있는 편이 낫다. */
const softFocus = el => { if (el && !narrow()) el.focus(); };

/* ── 뒷장 잠금 ────────────────────────────────────────────
   덮개(시트 · 사이드 메뉴)가 떠 있는 동안 뒤 화면이 구르지 않게, **문서를 있던 자리에
   붙들어 둔다** (`position: fixed; top: -Ypx`). 닫을 때 보던 자리로 되돌린다.
   `overflow: hidden` 만으로는 아이폰이 말을 듣지 않는다 — 손가락으로는 그대로 구른다.
   문서가 못 구르면 그만이므로 손짓을 가로채는 장치는 두지 않는다.
   시트와 사이드 메뉴가 겹쳐 뜰 수 있어 잠금은 세어 둔다. */
let locks = 0, lockedAt = 0;

function lockScroll(on) {
  if (!narrow()) return;                     // 넓은 화면은 문서가 구르지 않는다
  if (on) {
    if (locks++) return;
    lockedAt = window.scrollY;
    document.body.style.top = `-${lockedAt}px`;
    document.documentElement.classList.add("locked");
  } else {
    if (locks > 0 && --locks) return;
    locks = 0;
    document.documentElement.classList.remove("locked");
    document.body.style.top = "";
    // 붙잡는 동안 브라우저가 화면을 밀어 올렸을 수 있다 — 보던 자리로 되돌린다
    window.scrollTo(0, lockedAt);
  }
}


/** when 을 주면 "언제 봤는지" 대신 그 글을 적는다 — 공개 예정은 남은 날을 보여 준다.

    **`.map(workCard)` 로 부르지 말 것.** map 은 둘째 자리에 번호를 넘기므로 카드마다
    0·1·2… 가 시각 자리에 찍힌다. 부르는 쪽은 `.map(w => workCard(w))` 로 적는다. */
function workCard(w, when) {
  return `<button class="work${w.visits ? "" : " unseen"}" data-id="${w.id}">
    <div class="cover" style="${coverStyle(w)}">${coverChar(w)}
      ${w.episode ? `<span class="ep">${esc(w.episode)}</span>` : ""}
      ${/* 아직 한 번도 안 열어 본 것. 담자마자 목록 맨 앞에 서므로 눈에 띄는 표가
           하나 있어야 "새로 온 것" 과 "늘 거기 있던 것" 이 갈린다. */""}
      ${w.visits ? "" : `<span class="new-dot" aria-label="아직 안 본 작품"></span>`}
    </div>
    <h4>${esc(w.title)}</h4><time>${esc(when ?? ago(w.lastAt))}</time>
  </button>`;
}

function gridHtml(list, emptyMsg) {
  if (!list.length) return `<div class="empty">${emptyMsg}</div>`;
  return `<div class="grid">${list.map(w => workCard(w)).join("")}</div>`;
}

/* ── 작품 격자에서 여럿 고르기 ────────────────────────────
   폴더 안과 구간별 세부 목록이 **같은 카드를 같은 손짓으로** 다루는 자리라, 고르는 물건도
   하나만 둔다. 고른 것은 한꺼번에 감상 완료나 휴지통으로 보낸다 — 지우는 것이 아니라
   보관함으로 옮기는 일이라 되돌릴 길이 남는다.

   `key` 는 지금 어느 목록을 고르고 있는지다. 다른 목록으로 넘어가면 고른 것을 버린다 —
   폴더 A 에서 셋을 골라 둔 채 폴더 B 를 열었는데 그 셋이 따라오면 엉뚱한 것을 옮긴다. */
/* `key` 가 null 이면 **고를 수 없는 화면**이다(묶음만 늘어놓은 자리). 그때는 고른 것을
   버리고 줄도 세우지 않는다 — 카드가 여러 묶음에 흩어져 있어 「전체 해제」가 무엇을
   가리키는지 알 수 없고, 골라 놓고 다른 묶음으로 넘어가면 보이지 않는 것을 옮기게 된다. */
let workSel = null, workSelKey = null;
const workPickAt = key => {
  if (key === null) { workSel = null; workSelKey = null; return; }
  if (workSelKey !== key) { workSel = null; workSelKey = key; }
};

/** 고르는 중인 카드. 켜진 것은 표지를 덮고 체크를 얹는다.

    **고르는 자리는 둘인데 카드는 하나다** — 목록에서 여럿 골라 옮기는 것과 「작품 넣기」.
    한때 같은 마크업이 두 벌 있었고, 한쪽만 고치면 같은 손짓인데 모양이 달라 보였다.
    다른 것은 무엇으로 표시하고(attr) 어디에 담아 두느냐(picked)뿐이다. */
const pickCardHtml = (w, attr, picked) => `<button class="work pick-work${picked.has(w.id) ? " on" : ""}"
    ${attr}="${esc(w.id)}" aria-pressed="${picked.has(w.id)}">
    <div class="cover" style="${coverStyle(w)}">${coverChar(w)}
      ${w.episode ? `<span class="ep">${esc(w.episode)}</span>` : ""}
      <span class="tick">${icon("check")}</span>
    </div>
    <h4>${esc(w.title)}</h4><time>${ago(w.lastAt)}</time>
  </button>`;

const workPickCard = w => pickCardHtml(w, "data-wpick", workSel);

/** 고르는 중이면 고르는 격자로, 아니면 여느 격자로 */
const workGridHtml = (list, emptyMsg) => workSel
  ? (list.length ? `<div class="grid">${list.map(workPickCard).join("")}</div>`
    : `<div class="empty">${emptyMsg}</div>`)
  : gridHtml(list, emptyMsg);

/** 목록 위 줄 — 고르기 전에는 「선택」, 고르는 중에는 셈과 실행 */
const workBarHtml = any => {
  if (!any || workSelKey === null) return "";
  if (!workSel)
    return `<div class="fr-pick tight"><button class="mini-btn" data-wsel>선택</button></div>`;
  /* **고른 것에 남의 작품이 섞여 있을 수 있다.** 함께 쓰는 폴더에는 내 작품과 친구
     작품이 한자리에 서고, 비추는 폴더는 통째로 남의 것이다. 할 수 있는 일이 서로
     달라서 버튼도 갈라 세운다 — 남의 것은 **담아 오는 것**뿐이고(내 것이 아니라
     고칠 수 없다), 내 것은 **옮기는 것**뿐이다(담을 것이 없다).

     한때 갈라 두지 않아서, 비추는 폴더에서 남의 작품을 골라 휴지통을 누르면 서버가
     404 를 돌려줬다. 누르는 사람에게는 아무 일도 안 일어나는 것처럼 보였다.

     「미러링만」으로 열어 둔 폴더는 담아갈 수 없다 — canCopy 가 그것을 가른다. */
  /* **셈을 갈라 적지 않는다.** 「담아가기 3 · 감상 완료 2」처럼 적어 두면 고르는 사람이
     제가 무엇을 골랐는지 머릿속으로 갈라 세야 한다. 통째로 골라 누르면 각 버튼이 제
     몫만 집어 간다 — 담아가기는 남의 것만, 감상 완료·휴지통은 내 것만. */
  const picked = [...workSel].map(id => works.find(w => w.id === id)).filter(Boolean);
  const canTake = picked.filter(mayTakeWork);
  const mine = picked.filter(w => !w.mirror);
  return `<div class="bulk">
    <b>${workSel.size}개 선택</b>
    ${workSel.size ? `<button class="mini-btn" data-wsel-all>전체 해제</button>` : ""}
    <span class="bulk-act">
      ${canTake.length ? `<button class="mini-btn on" data-wtake
        >${icon("plus")} 담아가기</button>` : ""}
      ${mine.length ? `<button class="mini-btn" data-wbulk="watched"
        >${icon("check")} 감상 완료</button>
      <button class="mini-btn danger" data-wbulk="dropped"
        >${icon("trash")} 휴지통</button>` : ""}
      <button class="mini-btn" data-wsel-off>완료</button>
    </span></div>`;
};

/** 고르는 손짓을 잇는다. `redraw` 는 부르는 쪽이 제 화면을 다시 그리는 길이다. */
function wireWorkPick(box, redraw) {
  // 카드를 꾹 누르면 그 카드가 골라진 채로 고르기에 들어간다
  holdToPick(box, ".work[data-id], .work[data-wpick]", card => {
    if (!workSel) workSel = new Set();
    workSel.add(card.dataset.id ?? card.dataset.wpick);
    redraw();
  });

  box.addEventListener("click", e => {
    if (e.target.closest("[data-wsel]")) { workSel = new Set(); return redraw(); }
    if (e.target.closest("[data-wsel-off]")) { workSel = null; return redraw(); }
    if (e.target.closest("[data-wsel-all]")) { workSel.clear(); return redraw(); }
    const c = e.target.closest("[data-wpick]");
    if (c) {
      const id = c.dataset.wpick;
      const on = !workSel.has(id);
      on ? workSel.add(id) : workSel.delete(id);
      /* **그 카드만 뒤집는다.** 격자를 통째로 다시 그리면 지금 짚고 있는 카드가 그 자리에서
         사라졌다 새로 생겨, 훑으며 톡톡 짚을 때 두 번째부터 헛손질이 된다. */
      c.classList.toggle("on", on);
      c.setAttribute("aria-pressed", String(on));
      const bar = box.querySelector("[data-wbar]");
      if (bar) { bar.innerHTML = workBarHtml(true); }
      return;
    }
  });

  /* 골라 둔 남의 작품을 한꺼번에 담는다.

     **주인이 여럿일 수 있다** — 함께 쓰는 폴더에는 여러 사람이 넣는다. 담아가는 길은
     주인마다 따로라(누가 무엇을 열어 두었는지가 사람마다 다르다) 주인별로 묶어 보낸다. */
  box.addEventListener("click", guard(async e => {
    if (!e.target.closest("[data-wtake]")) return;
    const list = [...workSel].map(id => works.find(w => w.id === id)).filter(w => w && mayTakeWork(w));
    if (!list.length) return;
    const byOwner = new Map();
    for (const w of list) {
      let a = byOwner.get(w.mirror);
      if (!a) byOwner.set(w.mirror, a = []);
      a.push(w.id);
    }
    let added = 0, already = 0, skipped = 0;
    for (const [owner, ids] of byOwner) {
      const r = await api("POST", `/api/friends/${owner}/take`, { works: ids });
      added += r.added; already += r.already; skipped += r.skipped;
    }
    workSel = null;
    await reload(); render(); redraw();
    toast(added
      ? `${added}편 담았습니다${already ? ` · ${already}편은 이미 있었습니다` : ""}`
      : already ? `${already}편 모두 이미 담겨 있습니다`
        : "담아갈 수 있는 작품이 없습니다");
  }));

  box.addEventListener("click", guard(async e => {
    const b = e.target.closest("[data-wbulk]"); if (!b) return;
    const to = b.dataset.wbulk, ids = [...workSel];
    if (!ids.length) return;
    /* **내 것만 집는다.** 함께 쓰는 폴더에서 통째로 골랐으면 남의 작품이 섞여 있는데,
       남의 작품 상태는 내가 못 바꾼다 — 그대로 보내면 서버가 404 를 돌려주고 누른
       사람에게는 아무 일도 안 일어난 것처럼 보인다. 담아가기가 남의 것만 집는 것과
       같은 규칙이다. */
    const picked = ids.map(id => works.find(w => w.id === id)).filter(w => w && !w.mirror);
    if (!picked.length) return;
    const label = STATES[to].label;

    /* **감상 완료는 별점을 묻는다** — 한 편을 옮길 때와 같다. 나중에 별점별로 모아 보는
       것이 그 값의 쓰임이라, 여럿을 한꺼번에 끝낼 때야말로 매겨 둘 만하다. */
    if (to === "watched") {
      return openRating(picked, to, { after: () => {
        workSel = null;
        toast(`${picked.length}편을 ${label}${ro(label)} 옮겼습니다`);
        redraw();
      } });
    }

    /* 휴지통은 묻지 않는다 — 버리는 것에 점수를 매길 일은 없다. 대신 정말 내릴 것인지는
       묻는다. 취소는 **보던 목록으로** 돌아간다: 되묻는 창만 닫히고 창까지 닫히면 안 된다. */
    const yes = await askSure({
      title: `${picked.length}편을 ${label}${ro(label)} 옮길까요?`,
      ok: label, danger: true, back: redraw,
      body: "지워지지 않습니다. 왼쪽 메뉴의 보관함으로 옮겨지고, 거기서 되돌릴 수 있습니다. 매겨 둔 별점도 그대로 남습니다.",
    });
    if (!yes) return;
    for (const id of ids) await api("PATCH", `/api/works/${id}`, { state: to });
    workSel = null;
    await reload(); render();
    toast(`${picked.length}편을 ${label}${ro(label)} 옮겼습니다`);
    redraw();
  }));
}

/* 홈 — 플랫폼별 가로 슬라이드. 입력이 최근순이라 Map 삽입 순서가 곧 최근 플랫폼 순이다. */
function railsHtml(list) {
  if (!list.length)
    return `<div class="empty">아직 등록된 작품이 없습니다.<br>왼쪽 아래 ＋ 버튼으로 추가해보세요.</div>`;
  const groups = new Map();
  for (const w of list) {
    if (!groups.has(w.platformId)) groups.set(w.platformId, []);
    groups.get(w.platformId).push(w);
  }
  return [...groups].map(([pid, items]) => {
    const p = platformOf(pid);
    return `<section class="plat">
      <div class="plat-h">
        <span class="pmark" style="background:${p.color};color:${p.fg}">${esc(p.initial)}</span>
        <b${p.isDomain && !p.overridden ? ' class="dom"' : ""}>${esc(p.name)}</b>
        <button class="edit-dom" data-plat="${esc(pid)}" title="이름·색·마크 바꾸기">${icon("pencil")}</button>
        <span>${items.length}편</span>
        <span class="plat-act">
          <button class="edit-dom" data-plat-all="${esc(pid)}" title="전체 목록" aria-label="전체 목록">${icon("list")}</button>
        </span>
      </div>
      <div class="rail">${items.map(w => workCard(w)).join("")}</div>
    </section>`;
  }).join("");
}

function rowHtml(w, sub, mini) {
  const p = platformOf(w.platformId);
  const st = w.state === "active" ? null : STATES[w.state];
  return `<button class="row${mini ? " mini" : ""}${st ? " done" : ""}" data-id="${w.id}"
    ${st ? `title="${esc(st.label)}"` : ""}>
    <span class="thumb" style="${coverStyle(w)}">${coverChar(w)}</span>
    <span class="rt"><b>${st ? `<i class="st">${icon(st.icon)}</i> ` : ""}${esc(w.title)}</b>
      <span>${esc(sub ?? p.name)}</span></span>
    <span class="pdot" style="background:${workColor(w)}"></span>
  </button>`;
}

/* 격자에는 내려둔 작품도 놓는다 — "언제부터 언제까지 보던 작품"이 기록으로 남는다.
   격자 아래 단락들은 앞으로 볼 것을 위한 자리라 활성 작품만 다룬다. */
function updatesOn(date) {
  /* **최근 실행 순.** 한때 많이 본 순이었는데, 그러면 새로 담은 작품이 늘 맨 뒤로 가서
     정작 챙겨야 할 것이 안 보였다. 담을 때 lastAt 을 지금으로 두므로 새것이 맨 앞에 선다. */
  return byRecent(works.filter(w => occursOn(w, date)));
}

/* 달력 한 칸에 매주·격주·매월·날짜 지정이 뒤섞여 있으면 무엇이 오늘만의 일인지 안 보인다.
   **날짜 지정이 맨 위**다 — 그날 하루뿐인 일이라 놓치면 끝이고, 매주 오는 것은 다음 주에도 온다.
   나머지는 자주 오는 순서(매주 → 격주 → 매월)로 둔다. */
const SCHED_GROUPS = [
  ["dated", "날짜 지정"], ["weekly", "매주"], ["biweekly", "격주"], ["monthly", "매월"],
];
// 매월은 "며칠" 과 "몇째 주 무슨 요일" 두 가지가 있는데, 보는 사람에게는 한 가지다
const schedGroup = w => (w.schedule.mode === "monthly-dow" ? "monthly" : w.schedule.mode);
const groupRank = w => {
  const i = SCHED_GROUPS.findIndex(([k]) => k === schedGroup(w));
  return i < 0 ? SCHED_GROUPS.length : i;      // 모르는 주기는 뒤로
};

/** 그날 것을 주기별로 갈라 준다. 빈 묶음은 내보내지 않는다. */
function updatesByMode(date) {
  const all = updatesOn(date);
  return SCHED_GROUPS
    .map(([key, label]) => ({ key, label, items: all.filter(w => schedGroup(w) === key) }))
    .filter(g => g.items.length)
    .concat(((rest) => rest.length ? [{ key: "etc", label: "그 밖", items: rest }] : [])(
      all.filter(w => !SCHED_GROUPS.some(([k]) => k === schedGroup(w)))));
}

function idleReason(w) {
  const s = w.schedule;
  if ((s.mode === "weekly" || s.mode === "biweekly") && !s.days.length) return "요일 미선택";
  if (s.mode === "monthly" && !s.days.length) return "날짜 미선택";
  if (s.mode === "monthly-dow" && !s.days.length) return "주차 미선택";
  if (s.mode === "dated" && !s.next) return "날짜 미지정";
  return SCHED_LABEL[s.mode] ?? "일정 미정";
}

/* 주간·월간 공통 꼬리. 격자에 놓이지 못한 작품을 여집합으로 모은다.
   캘린더는 앞으로 볼 것을 위한 화면이므로, 지난 공개만 예외로 빠진다. */
/** 캘린더에 놓일 근거가 아직 없는 작품 — 손봐야 할 것들.
    "지금 보고 있는 창에 안 나타남"과는 다르다. 8/31 월요일에 수요일 연재를 보면
    8월엔 남은 수요일이 없지만, 그건 설정이 빠진 게 아니라 그 달이 끝나가는 것뿐이다. */
function unscheduled(w) {
  const s = w.schedule;
  if (["weekly", "biweekly", "monthly", "monthly-dow"].includes(s.mode)) return !s.days.length;
  if (s.mode === "dated") return !s.next;
  if (s.mode === "always" || s.mode === "done") return false;
  return true;   // 미정 · 휴재, 그리고 모르는 값
}

function calTail() {
  let html = "";
  // 모든 단락이 오늘과 데이터만 본다. 달을 넘기거나 날짜를 눌러도 내용이 그대로여야 한다.
  const t0 = midnight().getTime();
  const dated = m => activeWorks().filter(w =>
    w.schedule.mode === "dated" && w.schedule.next && m(w.schedule.next));

  /* 공개 예정은 **달력 바로 아래에** 제 단락으로 선다 — 날짜가 있는 것들이라 달력의
     이야기이고, 한 줄씩 늘어놓는 대신 가로로 훑으므로 자리를 많이 먹지 않는다.
     날짜에 놓이지 않는 작품(상시·완결·일정 미정)은 여기 두지 않는다 — 손봐야 할
     목록이라 성격이 다르고, 오른쪽 아래 📋 의 「추가 목록」에서 본다. */
  /* 요일 통과 같은 테두리 박스에 담는다 — 나란히 놓인 두 덩이가 한 몸으로 보이면
     어디까지가 이번 주이고 어디부터가 예정인지 갈리지 않는다. */
  const soon = soonSection();
  if (soon.items.length) html += `<div class="cal-box">${secHtml(soon, "data-soon-all")}</div>`;

  // 이미 지난 공개는 앞으로 할 일이 아니고 시간이 갈수록 쌓이기만 한다 — 목록에서 뺀다.
  const past = dated(t => t < t0);

  // 조용히 사라지면 "내 작품 어디 갔지"가 된다. 한 줄로만 알린다 — 늘어나지 않는다.
  if (past.length)
    html += `<div class="cal-note">지난 공개 ${past.length}편은 목록에 넣지 않습니다. 달력 칸과 페이지·폴더에서 볼 수 있습니다.</div>`;
  return html;
}

/** 달력의 어느 날에도 놓이지 않는 작품 — 상시·완결과 아직 안 정한 것들 */
const undated = w => ["always", "done"].includes(w.schedule.mode) || unscheduled(w);
const idleWorks = () => byRecent(activeWorks().filter(undated));
/** 왜 날짜가 없는지 한마디로 */
const undatedReason = w => ["always", "done"].includes(w.schedule.mode)
  ? SCHED_LABEL[w.schedule.mode] : idleReason(w);

const calSwitch = () => `<div class="cal-top">
    <div class="cal-switch">${[["week", "주간"], ["month", "월간"]]
      .map(([v, label]) => `<button data-calview="${v}" aria-selected="${calView === v}">${label}</button>`)
      .join("")}</div>
  </div>`;

/* 달력 칸에서 눈에 안 띄는 것들을 오른쪽 아래 아이콘 하나로 모은다.

   두 종류다 — **공개 예정**(날짜는 있지만 아직 안 왔다)과 **날짜 미지정**(놓일 근거가 없다).
   앞엣것은 달력 어딘가에 있긴 하지만 달을 넘겨야 보이고, 뒤엣것은 아예 안 놓인다.
   둘 다 "지금 화면에는 없지만 알고 있어야 하는 것" 이라 한 창에 둔다.

   null 이면 단락들을 가로 목록으로 훑는 화면, 값이 있으면 그 단락의 전체 목록이다.
   전체 목록은 **창을 새로 띄우지 않고 같은 창 안에서** 갈아 끼운다 — 곁창 위에 또
   곁창이 쌓이면 어디까지 돌아가야 하는지 알 수 없다. 대신 머리줄에 ‹ 를 둔다. */
let idleSec = null;

/** 날짜는 정해졌지만 아직 안 온 것 — 가까운 날 먼저 */
const upcoming = () => activeWorks()
  .filter(w => w.schedule.mode === "dated" && w.schedule.next && w.schedule.next >= midnight().getTime())
  .sort((a, b) => a.schedule.next - b.schedule.next);

/** 가로로 훑는 단락 하나. 추가 목록과 캘린더의 「공개 예정」이 같은 모양을 쓴다 —
    같은 물건을 두 곳에서 다르게 그릴 이유가 없다.

    공개 예정은 "언제 봤는지" 가 뜻이 없다(아직 안 나왔으니 본 적이 없다). 그 자리에
    며칠 남았는지를 적는다. */
const secHtml = (g, allAttr) => `<section class="plat">
    <div class="plat-h">
      <i class="idot" style="background:${g.color}"></i>
      <b>${esc(g.label)}</b><span>${g.items.length}편</span>
      <span class="plat-act">
        <button class="edit-dom" ${allAttr}
          title="전체 목록" aria-label="${esc(g.label)} 전체 목록">${icon("list")}</button>
      </span>
    </div>
    <div class="rail">${g.items.map(w => workCard(w,
      g.key === "_soon" ? daysLeft(w.schedule.next) : undefined)).join("")}</div>
  </section>`;

/** 공개 예정 — 날짜는 정해졌지만 아직 안 온 것. 캘린더 아래에 제 단락으로 선다. */
const soonSection = () => ({ key: "_soon", label: "공개 예정",
  color: "var(--accent)", items: upcoming() });

/* 추가 목록에는 **날짜 미지정만** 담는다. 공개 예정은 달력 바로 아래에서 보는 것이
   더 가깝다 — 날짜가 있는 것들이라 달력의 이야기이고, 미지정은 손봐야 할 목록이다. */
const idleSections = () => idleGroups();

const idleTotal = () => idleWorks().length;

function openIdle() {
  idleSec = null;
  drawIdle();
}

/** 공개 예정 전부 — 캘린더 아래 단락의 ☰ 가 연다. 추가 목록의 전체 목록과 같은 줄 모양이다. */
/* 세부 목록은 **폴더 안과 같은 격자**다 (gridHtml). 한 줄씩 늘어놓던 때는 표지가 작아
   무엇인지 알아보기 어려웠는데, 목록을 훑는 일은 결국 표지를 보는 일이다.
   훑는 자리(가로 슬라이드)와 다루는 자리(격자)의 모양이 앱 전체에서 같아진다. */
function openSoon() {
  const g = soonSection();
  workPickAt("soon");
  openSheet(`<div data-wbar>${workBarHtml(g.items.length)}</div>
    ${workGridHtml(g.items, "공개 예정인 작품이 없습니다.")}`,
    { full: true, title: "공개 예정", sub: `${g.items.length}편 · 가까운 날부터` });
  wireWorkPick(sheet.querySelector(".sheet-body"), openSoon);
  sheet.querySelector(".sheet-body").addEventListener("click", e => {
    if (workSel) return;                       // 고르는 중에는 열어 볼 일이 없다
    const r = e.target.closest("[data-id]");
    if (r) openWork(r.dataset.id, openSoon);   // 목록 위에 겹친다
  });
}

/* 폴더가 아니라 "왜 날짜가 없는지" 로 나눈다. 상시로 담은 작품이 폴더가 없다는 이유로
   "미분류" 에 들어가면, 정작 알고 싶은 것(상시인지 아직 안 정한 것인지)이 안 보인다.
   앞의 넷은 사용자가 그렇게 정한 상태이고, 뒤는 정하다 만 것들이다. */
const IDLE_ORDER = ["상시", "완결", "휴재", "일정 미정",
                    "요일 미선택", "날짜 미선택", "날짜 미지정"];
/* 앞의 넷은 그렇게 정한 상태라 저마다 색을 주고, 정하다 만 것들은 한 색으로 묶는다 —
   "손봐야 할 것" 이라는 점에서 셋이 같기 때문이다. */
const IDLE_COLOR = {
  "상시": "#2F9E44", "완결": "#1971C2", "휴재": "#F08C00", "일정 미정": "#868E96",
};
const idleColor = k => IDLE_COLOR[k] ?? "#E8590C";

function idleGroups() {
  const list = idleWorks();
  const by = new Map();
  for (const w of list) {
    const k = undatedReason(w);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(w);
  }
  // 정해둔 차례를 먼저, 모르는 값이 생기면 뒤에 붙인다
  const keys = [...by.keys()].sort((a, b) => {
    const ia = IDLE_ORDER.indexOf(a), ib = IDLE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return keys.map(k => ({ key: k, label: k, color: idleColor(k), items: by.get(k) }));
}

function drawIdle() {
  const secs = idleSections();
  const total = secs.reduce((n, g) => n + g.items.length, 0);
  const sec = idleSec === null ? null : secs.find(g => g.key === idleSec);
  if (idleSec !== null && !sec) idleSec = null;        // 다 정리해 그 단락이 비었다

  // 단락 제목이 곧 이유라, 줄에는 폴더와 플랫폼을 보여 준다
  const row = w => rowHtml(w, [
    w.schedule.mode === "dated" && w.schedule.next
      ? `${daysLeft(w.schedule.next)} · ${schedText(w)}` : null,
    folderNames(w) || null,
    platformOf(w.platformId).name,
  ].filter(Boolean).join(" · "));

  // 세부 목록에서만 고를 수 있다 — 묶음 화면에는 고를 카드가 흩어져 있다.
  // **몸을 짓기 전에** 정해야 한다: 줄을 그릴 때 이 값을 본다.
  workPickAt(sec ? "idle:" + sec.key : null);

  const head = (title, back) => `<div class="crumb">
      ${back ? `<button data-idle-back aria-label="돌아가기">${icon("left")}</button>` : ""}
      <h3>${title}</h3></div>`;

  let body;
  if (!total) {
    body = head("추가 목록", false)
      + `<div class="empty">모두 달력에 놓여 있습니다.</div>`;
  } else if (!sec) {
    /* 페이지 탭과 같은 모양 — 단락마다 가로로 밀어 보고, ☰ 로 그 단락 전부를 편다.
       훑는 것과 다루는 것은 다른 일이라 화면을 나눈다. */
    body = head("추가 목록", false)
      + `<p class="sub">${total}편 · 달력에 놓일 근거가 아직 없는 것들입니다.</p>`
      + secs.map(g => secHtml(g, `data-idle-all="${esc(g.key)}"`)).join("");
  } else {
    body = head(`<i class="idot" style="background:${sec.color}"></i>${esc(sec.label)}`, true)
      + `<p class="sub">${sec.items.length}편</p>`
      + `<div data-wbar>${workBarHtml(sec.items.length)}</div>`
      + workGridHtml(sec.items, "비어 있습니다.");
  }
  openSheet(body);

  /* 리스너는 openSheet 이 매번 새로 만드는 자식에 붙인다 — sheet 자체에 붙이면
     다시 그릴 때마다 쌓인다. ‹ 는 머리로 옮겨지고 ☰ 와 카드는 본문에 남는다. */
  wireWorkPick(sheet.querySelector(".sheet-body"), drawIdle);
  const onClick = e => {
    const a = e.target.closest("[data-idle-all]");
    if (a) { idleSec = a.dataset.idleAll; return drawIdle(); }
    if (e.target.closest("[data-idle-back]")) { idleSec = null; return drawIdle(); }
    if (workSel) return;                       // 고르는 중에는 열어 볼 일이 없다
    const r = e.target.closest("[data-id]");
    // 다른 목록과 똑같이 작품 화면부터 — 보러갈 수도 있어야 한다.
    // 곁창을 닫지 않고 그 위에 겹친다 — 닫으면 보던 자리로 돌아온다.
    if (r) openWork(r.dataset.id, drawIdle);
  };
  sheet.querySelector(".sheet-top").addEventListener("click", onClick);
  sheet.querySelector(".sheet-body").addEventListener("click", onClick);
}

/* 하루에 여러 편이 몰리면 칸이 끝없이 길어져 달력 구실을 못 한다.
   다섯 편까지만 보이고 나머지는 팝업으로 넘긴다. */
const WEEK_MAX = 5;

/* 하루의 목록도 추가 목록과 같은 두 겹이다 — 묶음(매주·격주·매월)을 가로로 훑다가
   ☰ 로 그 묶음 전부를 편다. 세부로 들어가면 ‹ 로 되돌아온다.
   창을 새로 쌓지 않고 **같은 창 안에서** 갈아 끼운다. */
let dayGrp = null;

function openDayList(t, grp = null) {
  dayGrp = grp;
  drawDayList(t);
}

function drawDayList(t) {
  const d = new Date(t);
  const groups = updatesByMode(d).map(g => ({ ...g, items: byRecent(g.items) }));
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const same = midnight().getTime() === t;
  const g = dayGrp === null ? null : groups.find(x => x.key === dayGrp);
  if (dayGrp !== null && !g) dayGrp = null;      // 다 정리해 그 묶음이 비었다

  // 세부 목록에서만 고를 수 있다 — 몸을 짓기 전에 정해야 줄이 제대로 선다
  workPickAt(g ? `day:${t}:${g.key}` : null);

  const title = `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;
  const body = !total
    ? `<div class="empty">이 날에는 놓인 작품이 없습니다.</div>`
    : g
      ? `<div class="crumb"><button data-day-back aria-label="돌아가기">${icon("left")}</button>
           <h3>${esc(g.label)}</h3><span class="count">${g.items.length}편</span></div>
         <div data-wbar>${workBarHtml(g.items.length)}</div>
         ${workGridHtml(g.items, "비어 있습니다.")}`
      : groups.map(x => `<section class="plat">
          <div class="plat-h"><b>${esc(x.label)}</b><span>${x.items.length}편</span>
            <span class="plat-act">
              <button class="edit-dom" data-day-grp="${esc(x.key)}"
                title="전체 목록" aria-label="${esc(x.label)} 전체 목록">${icon("list")}</button>
            </span>
          </div>
          <div class="rail">${x.items.map(w => workCard(w)).join("")}</div>
        </section>`).join("");

  openSheet(body, {
    full: true,
    title: g ? `${title} · ${esc(g.label)}` : title,
    sub: `${total}편${same ? " · 오늘" : ""}`,
  });
  wireWorkPick(sheet.querySelector(".sheet-body"), () => drawDayList(t));
  sheet.querySelector(".sheet-body").addEventListener("click", e => {
    const b = e.target.closest("[data-day-grp]");
    if (b) { dayGrp = b.dataset.dayGrp; return drawDayList(t); }
    if (e.target.closest("[data-day-back]")) { dayGrp = null; return drawDayList(t); }
    if (workSel) return;                       // 고르는 중에는 열어 볼 일이 없다
    const w = e.target.closest(".work[data-id]");
    if (w) openWork(w.dataset.id, () => drawDayList(t));
  });
}

/* 이 폴더에 **아직 없는** 작품을 골라 한꺼번에 넣는다.

   폴더 쪽에서 작품을 부르는 길이다. 반대 방향(작품 쪽에서 폴더를 고르는 길)은 작품
   설정의 「폴더 바꾸기」가 이미 맡고 있는데, 한 폴더를 여러 편으로 채우려면 그 길로는
   작품마다 창을 열었다 닫아야 한다.

   **빼지는 않는다.** 빼는 것은 작품 쪽 일이라, 여기에 두면 같은 일을 하는 자리가 둘이
   되고 "고르개에서 체크를 풀면 빠지나" 를 사람이 헷갈린다. 여기 서는 것은 넣을 수
   있는 것들뿐이고, 고른 것은 더해지기만 한다. */
function openFolderAdd(f, back) {
  let picked = new Set(), q = "", detail = null;   // detail = 펼쳐 본 구간, 없으면 슬라이드 화면

  /* 넣을 수 있는 것 — **내 작품**이고, 아직 이 폴더에 없는 것. 비쳐 온 작품(w.mirror)은
     내 것이 아니라 넣을 수 없다: 남의 목록에 있는 것을 내가 다른 데 걸 수는 없다. */
  const pool = () => activeWorks().filter(w => !w.mirror && !w.folders.includes(f.id));
  const shown = () => {
    const t = q.trim().toLowerCase();
    return byRecent(t ? pool().filter(w => w.title.toLowerCase().includes(t)) : pool());
  };

  /* 구간(도메인)별로 묶는다. 폴더에 넣을 것을 고를 때 사람이 떠올리는 단위가 그것이라 —
     "네이버웹툰 것들을 넣자" 이지 "제목이 ㄱ 인 것들" 이 아니다.
     최근 순으로 들어오므로 Map 에 담긴 차례가 곧 최근 구간 순이다 (railsHtml 과 같은 결). */
  const groups = () => {
    const by = new Map();
    for (const w of shown()) {
      if (!by.has(w.platformId)) by.set(w.platformId, []);
      by.get(w.platformId).push(w);
    }
    return [...by];
  };

  /* 고르는 것도 **페이지 탭과 같은 카드**로 한다 — 같은 작품이 화면마다 다른 모양으로
     서면 어느 것이 무엇인지 다시 익혀야 한다. 다른 것은 눌렀을 때 열리는 대신 켜진다는
     것뿐이고, 켜진 것은 표지 위 체크로 말한다. */
  const card = w => pickCardHtml(w, "data-add", picked);

  const body = () => {
    const gs = groups();
    if (!gs.length)
      return `<div class="empty">${q ? "찾는 작품이 없습니다."
        : "넣을 수 있는 작품이 없습니다.<br>이 폴더에 이미 다 들어 있어요."}</div>`;

    // 한 구간을 펼쳐 본 화면 — 그 구간의 것을 격자로 다 늘어놓는다
    if (detail) {
      const items = gs.find(([pid]) => pid === detail)?.[1] ?? [];
      const p = platformOf(detail);
      const all = items.length && items.every(w => picked.has(w.id));
      return `<div class="plat-h" style="margin-bottom:12px">
          <button class="icon-btn" data-back-rails aria-label="구간 목록으로">${icon("left")}</button>
          <span class="pmark" style="background:${p.color};color:${p.fg}">${esc(p.initial)}</span>
          <b>${esc(p.name)}</b><span>${items.length}편</span>
          ${items.length ? `<button class="mini-btn" data-gall="${esc(detail)}">${
            all ? "구간 해제" : "구간 선택"}</button>` : ""}
        </div>
        ${items.length ? `<div class="grid">${items.map(card).join("")}</div>`
          : `<div class="empty">비어 있습니다.</div>`}`;
    }

    return gs.map(([pid, items]) => {
      const p = platformOf(pid);
      const all = items.every(w => picked.has(w.id));
      return `<section class="plat">
        <div class="plat-h">
          <span class="pmark" style="background:${p.color};color:${p.fg}">${esc(p.initial)}</span>
          <b${p.isDomain && !p.overridden ? ' class="dom"' : ""}>${esc(p.name)}</b>
          <span>${items.length}편</span>
          <span class="plat-act">
            <button class="mini-btn" data-gall="${esc(pid)}">${all ? "구간 해제" : "구간 선택"}</button>
            ${/* 페이지 탭과 같은 자리, 같은 아이콘 — 레일에 다 안 들어가면 여기서 펼친다 */""}
            <button class="edit-dom" data-more="${esc(pid)}" title="전체 목록" aria-label="전체 목록">${icon("list")}</button>
          </span>
        </div>
        <div class="rail">${items.map(card).join("")}</div>
      </section>`;
    }).join("");
  };

  const paintBulk = () => {
    const bar = sheet.querySelector("[data-add-bulk]");
    if (!bar) return;
    bar.innerHTML = picked.size
      ? `<div class="bulk"><b>${picked.size}개 선택</b>
          <span class="bulk-act"><button class="mini-btn" data-none>모두 해제</button></span></div>`
      : "";
    const off = bar.querySelector("[data-none]");
    if (off) off.onclick = () => { picked = new Set(); paint(); };
  };
  const paint = () => { sheet.querySelector("[data-add-body]").innerHTML = body(); paintBulk(); };

  const put = guard(async () => {
    if (!picked.size) { toast("넣을 작품을 골라 주세요"); return; }
    const { added } = await api("POST", `/api/folders/${f.id}/works`, { works: [...picked] });
    await reload(); render();
    /* 몇 편이 들었는지 그대로 말한다 — 골랐는데 일부만 들어가는 경우가 있다(함께 쓰는
       폴더에서 수락을 물린 뒤라든가). "넣었습니다" 만 말하면 없는 편을 찾으러 다니게 된다. */
    toast(added === picked.size ? `${added}편을 넣었습니다`
      : added ? `${picked.size}편 중 ${added}편만 들어갔습니다`
      : "넣지 못했습니다 — 이 폴더에 넣을 권한이 없습니다");
    back();
  });

  /* 전체 화면 시트다 — 레일이 옆으로 흐르고 목록이 길어서 낮은 창에는 담기지 않는다.
     전체 화면에는 제 제목줄(.sheet-head)이 따로 있으므로 headHtml 의 빵부스러기 대신
     그 줄 오른쪽에 버튼을 단다. .crumb-act 를 쓰지 않는 이유는 그것이 **마우스에서
     숨겨지기** 때문이다 — 낮은 창은 아래 버튼줄이 대신 서지만 여기는 그것도 없다. */
  openSheet(`
    ${searchHtml("제목으로 좁히기", "", "margin-bottom:10px")}
    <div data-add-bulk></div>
    <div data-add-body></div>`,
    { full: true, title: "작품 넣기", sub: `${f.emoji} ${esc(f.name)}` });

  const acts = document.createElement("span");
  acts.className = "head-act";
  acts.innerHTML = `<button class="mini-btn" data-cancel>취소</button>
    <button class="mini-btn on" data-done>넣기</button>`;
  sheet.querySelector(".sheet-head").append(acts);
  wireHead({ save: put, cancel: back, back });

  const box = sheet.querySelector(".sheet-body");
  // 치는 칸은 다시 그리지 않는다 — 한글이 조합 중에 깨진다
  box.addEventListener("input", e => {
    if (!e.target.closest(".arch-q")) return;
    q = e.target.value;
    detail = null;                 // 좁히면 구간 목록으로 — 펼쳐 둔 구간이 비어 있을 수 있다
    paint();
  });
  box.addEventListener("click", e => {
    if (e.target.closest("[data-back-rails]")) { detail = null; return paint(); }
    const more = e.target.closest("[data-more]");
    if (more) { detail = more.dataset.more; return paint(); }
    const g = e.target.closest("[data-gall]");
    if (g) {
      const items = groups().find(([pid]) => pid === g.dataset.gall)?.[1] ?? [];
      const all = items.every(w => picked.has(w.id));
      for (const w of items) all ? picked.delete(w.id) : picked.add(w.id);
      return paint();
    }
    const c = e.target.closest("[data-add]");
    if (c) {
      // 카드 하나만 뒤집는다 — 다시 그리면 레일이 맨 앞으로 되감긴다
      const on = picked.has(c.dataset.add);
      on ? picked.delete(c.dataset.add) : picked.add(c.dataset.add);
      c.classList.toggle("on", !on);
      c.setAttribute("aria-pressed", String(!on));
      // 구간 버튼 글자는 그 구간이 다 켜졌는지에 따라 바뀐다
      const sec = c.closest(".plat, .sheet-body");
      const gb = sec?.querySelector("[data-gall]");
      if (gb) {
        const items = groups().find(([pid]) => pid === gb.dataset.gall)?.[1] ?? [];
        gb.textContent = items.length && items.every(w => picked.has(w.id)) ? "구간 해제" : "구간 선택";
      }
      return paintBulk();
    }
  });
  paint();
}

/* 폴더 안은 팝업으로 연다. 목록을 떠나지 않으므로 여러 폴더를 훑어보기 쉽고,
   닫으면 보던 자리로 그대로 돌아온다.

   주소에는 그대로 #lib/<id> 로 남긴다 — 새로 고쳐도 열려 있던 폴더가 다시 열린다.
   그래서 openFolderId 는 "지금 열려 있는 폴더" 라는 뜻으로 계속 쓰고, 닫을 때 비운다. */
function openFolderSheet(id) {
  const f = folders.find(x => x.id === id);
  if (id !== "_all" && id !== "_none" && !f) return;      // 지워진 폴더
  openFolderId = id;
  writeHash();

  /* 🗂 · 🫙 는 우리가 고른 표식이라 그린 아이콘으로, 폴더 이모지는 그 사람이 고른 것이라
     그대로 둔다.

     **여기서 이미 다듬은 글을 만든다.** 아이콘은 우리가 그린 마크업이고 이름은 사람이
     친 글자라, 둘을 붙여 놓고 통째로 esc 에 넣으면 아이콘이 글자 그대로 찍힌다 —
     실제로 「전체」와 「미분류」 제목에 <svg …> 가 통째로 나왔다. 사람이 친 쪽만 여기서
     다듬고, 아래로는 이미 다듬어진 것으로 넘긴다. */
  const name = id === "_all" ? icon("grid") + " 전체"
    : id === "_none" ? icon("inbox") + " 미분류" : `${esc(f.emoji)} ${esc(f.name)}`;
  const inFolder = byRecent(worksIn(id));
  const shown = inFolder.filter(w => filter === "all" || w.mediaType === filter);
  const types = ["all", ...Object.keys(MEDIA).filter(t => inFolder.some(w => w.mediaType === t))];

  workPickAt("folder:" + id);          // 다른 폴더로 넘어가면 고른 것은 버린다
  openSheet(`${types.length > 2
      ? `<div class="chips">${types.map(t =>
          `<button class="chip" data-filter="${t}" aria-pressed="${filter === t}">${
            t === "all" ? "전체" : MEDIA[t]}</button>`).join("")}</div>`
      : ""}
    <div data-wbar>${workBarHtml(shown.length)}</div>
    ${workGridHtml(shown, id === "_none" ? "미분류 작품이 없습니다." : "이 폴더는 비어 있습니다.")}`, {
    full: true,
    title: name,               // 위에서 이미 다듬었다 — 여기서 또 esc 하면 아이콘이 글자가 된다
    /* 버튼이 무엇을 하는지는 버튼이 말한다 — 안내말에 "오른쪽 위 ⋯ 로 고칠 수 있습니다"
       를 적어 두었는데, 그건 아이콘이 알아볼 만하지 않다는 뜻이었다. 톱니로 바꾸면
       설명이 필요 없다. */
    sub: `${inFolder.length}개${f?.mirror ? ` · ${esc(f.mirrorOf)}님의 폴더를 미러링 중` : ""}`,
  });

  if (f) {
    // 전체·미분류는 진짜 폴더가 아니라 고칠 것이 없다
    const mk = (name, label, cls, onclick) => {
      const b = document.createElement("button");
      b.className = "icon-btn" + (cls ? " " + cls : "");
      b.innerHTML = icon(name);
      b.title = label;
      b.setAttribute("aria-label", label);
      b.onclick = onclick;
      return b;
    };

    /* 함께 쓰는 폴더에는 **누가 들어와 있는지**가 제목 바로 옆에 붙는다 — 초대해 놓고
       아무도 안 왔는데 그것을 알 길이 없으면 기다리는 줄도 모른다. 오른쪽 버튼 무리에
       섞어 두었을 때는 「이 폴더를 어떻게 할까」 버튼들 사이에 「누가 있나」 가 끼어
       무엇을 하는 자리인지 흐렸다. 제목에 딸린 것은 제목 옆에 둔다. */
    if (canEdit(f.take) || f.canEdit) {
      const who = mk("users", "공유자", "in-title", guard(async () => {
        // 이름을 보여 주려면 친구 목록이 있어야 한다 (「친구가 많아지면」)
        try { await loadFriends(); } catch { /* 못 불러와도 상태는 보여 준다 */ }
        openFolderPeople(f, () => openFolderSheet(id));
      }));
      sheet.querySelector(".sh-t h3").append(" ", who);
    }

    /* 즐겨찾기는 **폴더를 열어 놓고** 켠다. 자주 여는 폴더인지는 들어와 보고 아는 것이지
       목록을 훑으며 정하는 것이 아니고, 목록의 줄마다 별을 달면 이름 쓸 자리가 좁아진다.
       자리는 닫기 버튼 옆 — 없는 기기(손가락)에서는 그 자리를 그대로 물려받는다. */
    const fav = document.createElement("button");
    fav.className = "star sheet-fav";
    fav.title = "즐겨찾기";
    fav.setAttribute("aria-label", "즐겨찾기");
    const paintFav = () => paintStar(fav, f.starred);
    paintFav();
    fav.onclick = () => {
      flipStar(f);
      paintFav(); render();                  // 목록의 차례가 바로 바뀐다
      api("PUT", `/api/folders/${f.id}/star`, { starred: f.starred })
        .catch(err => { flipStar(f); paintFav(); render(); toast(err.message); });
    };
    sheet.querySelector(".sheet-top").append(fav);

    /* **이 폴더에 하는 일** 둘은 아래 좌우로 내린다 — 캘린더 탭의 ＋ 와 추가 목록이 앉는
       그 자리다. 손이 닿기 쉽고, 앱 전체에서 같은 자리에 같은 뜻이 선다.

       비추기만 하는 폴더에는 넣을 수 없다 — 그건 남의 폴더를 보여 주는 껍데기다.
       함께 쓰는 폴더만 예외다(canEdit): 그때는 원본 폴더에 걸린다. */
    const fab = (name, label, cls, onclick) => {
      const b = document.createElement("button");
      b.className = "fab in-sheet" + (cls ? " " + cls : "");
      b.title = label;
      b.setAttribute("aria-label", label);
      b.innerHTML = icon(name);
      b.onclick = onclick;
      sheet.append(b);
    };
    if (!f.mirror || f.canEdit)
      fab("plus", "작품 넣기", "", () => openFolderAdd(f, () => openFolderSheet(id)));
    fab("cog", "폴더 설정", "right", () => openFolderForm(f, f2 => {
      closeSheet();
      render();
      if (f2) openFolderSheet(f2.id);        // 고치고 나면 보던 폴더로 돌아온다
    }));
  }

  wireWorkPick(sheet.querySelector(".sheet-body"), () => openFolderSheet(id));

  sheet.querySelector(".sheet-body").addEventListener("click", e => {
    const c = e.target.closest(".chip");
    if (c) { filter = c.dataset.filter; return openFolderSheet(id); }
    if (workSel) return;                 // 고르는 중에는 열어 볼 일이 없다
    const w = e.target.closest(".work, .row");
    if (w) openWork(w.dataset.id, () => openFolderSheet(id));   // 폴더 위에 겹친다
  });
}

function renderCalendar() {
  return calSwitch() + (calView === "month" ? renderMonth() : renderWeek());
}

/* 주간 — 오늘부터 이레. 요일이 열이고, 좁은 화면에서는 세로로 쌓인다. */
function renderWeek() {
  const t0 = midnight(), todayDow = t0.getDay();
  const todayList = updatesOn(t0);
  /* 요일 목록을 제 통(.week-scroll)에 담는다. 좁은 화면에서는 일곱 요일이 세로로 쌓이는데,
     문서 전체가 굴러가면 오늘이 어디쯤인지 매번 찾아야 했다. 통이 따로 있으면 그 안에서만
     굴리면 되고, 열 때 오늘을 맨 위로 올려 둘 수 있다 (fitWeek 참고). */
  let html = `<div class="today-strip"><b>${DOW[todayDow]}요일</b>
    <span>${todayList.length ? `${todayList.length}편 업데이트` : "오늘은 쉬어가는 날"}</span></div>
    <div class="week-scroll"><div class="cal-grid">`;

  for (let i = 1; i <= 7; i++) {
    const dow = i % 7;                                   // 월(1) … 토(6) … 일(0)
    const offset = (dow - todayDow + 7) % 7;
    const d = new Date(t0.getTime() + offset * 864e5);
    const list = updatesOn(d);
    // 날짜 지정이 맨 위 — 그 안에서는 본래 차례(최근 실행 순)를 그대로 지킨다
    const shown = [...list].sort((a, b) => groupRank(a) - groupRank(b));
    html += `<div class="col"${offset === 0 ? " data-today" : ""}>
      <div class="colh"><b>${DOW[dow]}</b>
        <span>${offset === 0 ? "오늘" : `${d.getMonth() + 1}/${d.getDate()}`}</span></div>
      <div class="colb">${list.length
        ? shown.slice(0, WEEK_MAX).map(w => rowHtml(w, null, true)).join("")
          + (list.length > WEEK_MAX
            ? `<button class="more" data-day-all="${d.getTime()}">${icon("plus")}${
                list.length - WEEK_MAX}편 더보기</button>`
            : "")
        : `<div class="rest">—</div>`}</div>
    </div>`;
  }
  /* 어느 요일이 오늘이든 맨 위까지 올라올 수 있게 뒤에 빈 자리를 둔다. 얼마나 둘지는
     화면 크기에 달렸으므로 fitWeek 이 재서 정한다 — 여기서는 자리만 잡아 둔다. */
  html += `</div><div class="week-pad"></div></div>`;
  return html + calTail();
}

/* 통 안에서 무엇이 어디에 있는지 재는 법. 주간 달력과 친구 목록이 같은 것을 묻는다 —
   "이것을 맨 위로 올리려면 얼마나 굴러야 하나". 한 자리에 둔다. */

/** 통 맨 위에서 el 까지의 거리. 화면 좌표끼리 빼고 지금 굴러온 만큼을 더한다 —
    offsetTop 은 어느 조상이 기준인지에 따라 달라져서, 통이 어디에 담기든 같은 값이
    나오는 이 방법을 쓴다. */
const posIn = (box, el) =>
  el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;

/** at 자리가 맨 위까지 올라올 수 있도록 pad 를 **모자란 만큼만** 늘리고 그 자리를 돌려준다.
    넉넉히 두면 어디서나 허공이 딸려 온다. */
function padToReach(box, at, pad) {
  pad.style.height = "0px";
  pad.style.height = `${Math.max(0, at + box.clientHeight - box.scrollHeight)}px`;
  return at;
}

/** 주간의 요일 통 — 남은 자리를 재서 채우고, 오늘을 맨 위로 올린다.

    높이를 숫자로 박아 두면 글꼴·기기·주소창에 따라 매번 어긋난다. 통이 화면에서 시작하는
    자리를 재서 아래까지 채운다. 넓은 화면은 일곱 요일이 나란히 서므로 굴릴 것이 없다. */
function fitWeek() {
  const box = screenEl.querySelector(".week-scroll");
  if (!box) return;
  if (!narrow()) { box.style.maxHeight = ""; return; }
  /* 아래에 「공개 예정」 단락이 서므로 화면 끝까지 채우지 않는다. 남는 자리의 3분의 2쯤만
     쓰고 나머지를 넘겨준다 — 통이 화면을 다 먹으면 그 아래가 있는 줄도 모른다. */
  const room = innerHeight - box.getBoundingClientRect().top - 14;
  box.style.maxHeight = `${Math.max(240, Math.round(room * 0.68))}px`;

  const today = box.querySelector("[data-today]");
  const pad = box.querySelector(".week-pad");
  if (!today || !pad) return;
  // 요일은 늘 월→일 차례라 오늘이 앞쪽이면 아래에 남은 것이 모자라 끝까지 못 올라간다
  box.scrollTop = padToReach(box, posIn(box, today), pad);
}

/* 월간 — 한 달을 한눈에. 칸에는 작품을 다 못 넣으니 플랫폼 색 점으로 요약하고,
   고른 날의 목록을 격자 아래에 펼친다. */
/** 달을 넘긴다. 화살표든 손가락이든 같은 길로 온다 — 넘어온 쪽에서 미끄러져 들어온다. */
function moveMonth(n) {
  const t0 = midnight();
  const b = calMonth ? new Date(calMonth) : new Date(t0.getFullYear(), t0.getMonth(), 1);
  calMonth = new Date(b.getFullYear(), b.getMonth() + n, 1).getTime();
  render();
  const g = screenEl.querySelector(".mon-grid");
  if (g && !reduceMotion()) g.classList.add(n > 0 ? "from-right" : "from-left");
}

function renderMonth() {
  const t0 = midnight();
  const base = calMonth ? new Date(calMonth) : new Date(t0.getFullYear(), t0.getMonth(), 1);
  const y = base.getFullYear(), m = base.getMonth();
  const lead = new Date(y, m, 1).getDay();               // 1일 앞의 빈 칸 수
  const last = new Date(y, m + 1, 0).getDate();          // 이 달의 마지막 날
  const thisMonth = y === t0.getFullYear() && m === t0.getMonth();

  const inMonth = ts => { const d = new Date(ts); return d.getFullYear() === y && d.getMonth() === m; };
  // 고른 날이 없으면 목록을 열지 않는다. 달을 넘기면 선택도 자연히 풀린다.
  const sel = calDay && inMonth(calDay) ? new Date(calDay) : null;

  let html = `<div class="cal-nav">
    <button data-cal-move="-1" aria-label="이전 달">${icon("left")}</button>
    <b>${y}년 ${m + 1}월</b>
    <button data-cal-move="1" aria-label="다음 달">${icon("right")}</button>
    ${thisMonth ? "" : `<button class="today-btn" data-cal-today>오늘로</button>`}
  </div><div class="mon-grid">`;

  html += DOW.map((d, i) =>
    `<div class="mon-dow${i === 0 ? " sun" : i === 6 ? " sat" : ""}">${d}</div>`).join("");

  for (let i = 0; i < Math.ceil((lead + last) / 7) * 7; i++) {
    const day = i - lead + 1;
    if (day < 1 || day > last) { html += `<div class="mon-cell out"></div>`; continue; }
    const d = new Date(y, m, day);
    const list = updatesOn(d);
    const dots = list.slice(0, 4).map(w =>
      `<i style="background:${workColor(w)}${
        w.state === "active" ? "" : ";opacity:.4"}"></i>`).join("");
    html += `<button class="mon-cell${sameDay(d, t0) ? " today" : ""}${
      sel && sameDay(d, sel) ? " sel" : ""}"
      data-cal-day="${d.getTime()}" aria-label="${m + 1}월 ${day}일, ${list.length}편">
      <span class="dn">${day}</span>
      <span class="dots">${dots}${list.length > 4 ? `<em>+${list.length - 4}</em>` : ""}</span>
    </button>`;
  }
  html += `</div>`;

  if (sel) {
    const list = updatesOn(sel);
    // 주간과 같은 규칙 — 날짜 지정이 맨 위, 그 안에서는 최근 실행 순, 다섯 편까지만
    const shown = [...list].sort((a, b) => groupRank(a) - groupRank(b));
    html += `<div class="cal-sec day-panel">
      <div class="day-h">
        <h4>${m + 1}월 ${sel.getDate()}일 ${DOW[sel.getDay()]}요일${sameDay(sel, t0) ? " · 오늘" : ""}</h4>
        <span>${list.length ? `${list.length}편` : ""}</span>
        <button data-cal-close aria-label="목록 닫기">${icon("x")}</button>
      </div>
      ${list.length
        ? shown.slice(0, WEEK_MAX).map(w => rowHtml(w, schedText(w))).join("")
          + (list.length > WEEK_MAX
            ? `<button class="more" data-day-all="${sel.getTime()}">${icon("plus")}${
                list.length - WEEK_MAX}편 더보기</button>`
            : "")
        : `<div class="rest">이 날은 예정된 업데이트가 없습니다.</div>`}</div>`;
  }

  return html + calTail();
}

/** 폴더 하나하나에 대고 작품 전체를 훑는 대신, **한 번 훑어 갈라 둔다.**

    폴더 목록은 줄마다 두 가지를 묻는다 — 미리보기에 쓸 넷과 개수. 둘 다 worksIn 을
    거치면 폴더 F개에 훑기가 2F번이다. 폴더 40개 · 작품 800편에서 1.92ms 였고,
    갈라 두면 0.13ms 다. 넷만 고르느라 정렬을 손으로 하는 것은 더 보태 주지 않는다
    (재 보니 같은 0.13ms) — 그래서 안 한다.

    **판마다 새로 만든다.** 들고 있다가 작품이 바뀌면 숫자가 어긋나는데, 작품은 화면
    곳곳에서 손대므로 언제 낡았는지 지키기 어렵다. 만드는 값(한 번 훑기)이 쓰는 값보다
    작으니 지키느라 애쓸 일이 아니다. */
function folderIndex() {
  const idx = new Map();
  for (const w of works) {
    if (w.state !== "active") continue;
    for (const id of w.folders) {
      let a = idx.get(id);
      if (!a) idx.set(id, a = []);
      a.push(w);
    }
  }
  return idx;
}

function worksIn(fid) {
  // 전체·미분류는 **내가 보기로 한 것**만 — 남이 넣어 둔 것까지 세면 숫자가 낯설어진다
  if (fid === "_all") return activeWorks();
  if (fid === "_none") return activeWorks().filter(w => !w.folders.length);
  return filedWorks().filter(w => w.folders.includes(fid));
}

/** 폴더 탭 맨 위 — 지금 누구의 폴더를 보고 있는지와, 바꾸는 길 */
function whoseBar() {
  // 둘러보기에는 친구가 없다 — 바꿀 것이 없으니 머리줄도 두지 않는다
  if (guestMode()) return "";
  /* 돌아가는 길(내 폴더)이 왼쪽, 더 나가는 길(다른 친구 폴더)이 오른쪽이다 —
     읽는 차례와 같다. 둘 다 테마 색을 입는다: 여기서 할 수 있는 일이 이 둘뿐이라
     하나만 눈에 띌 이유가 없다. */
  return viewing
    ? `<div class="whose">
         <span class="wt">현재 폴더: <b>${esc(viewing.name)}</b></span>
         <span class="wa">
           <button class="mini-btn" data-mine>내 폴더</button>
           <button class="mini-btn on" data-whose>다른 친구 폴더</button>
         </span></div>`
    : `<div class="whose">
         <span class="wt">내 폴더</span>
         <span class="wa"><button class="mini-btn on" data-whose>친구 폴더 보기</button></span>
       </div>`;
}

/** 받은 폴더 초대 — 수락하면 곧바로 내 폴더 목록에 선다. */
/* 폴더에 얽힌 소식이 두 갈래다 — **들어오라는 것**과 **끊겼다는 것**. 성격이 반대라
   한 목록에 섞지 않는다: 수락 버튼 옆에 끊긴 소식이 서면 무엇을 하는 자리인지 흐려진다.

   자리도 갈랐다. 초대는 **폴더 탭의 🤝** 에, 끊겼다는 소식은 **상단바의 🔔** 에 있다 —
   초대는 폴더를 다루다 받는 것이지만, 끊겼다는 소식은 캘린더만 보는 사람에게도 온다.
   폴더 탭 안에 숨겨 두면 그 사람은 폴더가 빈 것을 한참 뒤에야 안다. */
const unreadNotices = () => folderNotices.filter(n => !n.read).length;

function openFolderInvites(back) {
  const draw = () => {
    openSheet(`
      ${headHtml("폴더 초대", { back: !!back, actions: false })}
      ${folderInvites.length ? `<div class="fr-list">${folderInvites.map(v => `
        <div class="inv">
          <span class="ub"><b>${esc(v.emoji)} ${esc(v.name)}</b>
            <span>${esc(v.ownerName)}님이 불렀습니다 · ${v.count}편</span></span>
          <span class="inv-act">
            <button class="mini-btn" data-no="${esc(v.folder)}">거절</button>
            <button class="mini-btn on" data-yes="${esc(v.folder)}">수락</button>
          </span>
        </div>`).join("")}</div>`
        : `<div class="empty">받은 초대가 없습니다.</div>`}
      <div class="rest" style="text-align:left;padding:10px 2px 0">
        함께 고치는 폴더입니다. 수락하면 내 작품을 넣고 뺄 수 있고, 남이 넣은 작품은
        폴더 안에서만 보입니다 — 내 캘린더에는 올라오지 않습니다.</div>`);
    if (back) sheet.querySelector("[data-head-back]").onclick = back;

    sheet.querySelector(".sheet-body").addEventListener("click", guard(async e => {
      const yes = e.target.closest("[data-yes]"), no = e.target.closest("[data-no]");
      if (!yes && !no) return;
      const id = (yes ?? no).dataset[yes ? "yes" : "no"];
      const name = folderInvites.find(v => v.folder === id)?.name ?? "";
      await api("POST", `/api/folder-invites/${id}/${yes ? "accept" : "decline"}`);
      await reload();
      render();
      // 다 처리했으면 물러난다 — 빈 목록을 들여다볼 이유가 없다
      if (!folderInvites.length) { if (back) back(); else closeSheet(); }
      else draw();
      toast(yes ? `«${name}» 폴더에 들어왔습니다` : `«${name}» 초대를 물렸습니다`);
    }));
  };
  draw();
}

/** 끊겼다는 소식. 여는 순간 읽음으로 둔다 — 붉은 숫자는 "봤나" 를 세는 것이다. */
function openBreakNotices(back) {
  openSheet(`
    ${headHtml("알림", { back: !!back, actions: false })}
    ${folderNotices.length ? `<div class="fr-list">${folderNotices.map(n => `
      <div class="inv${n.read ? "" : " new"}">
        <span class="ub"><b>${esc(n.emoji)} ${esc(n.name)}</b>
          <span>${esc(n.ownerName)}님의 폴더 · ${esc(n.reason)} · ${ago(n.at)}</span></span>
      </div>`).join("")}</div>`
      : `<div class="empty">새 소식이 없습니다.</div>`}`);
  if (back) sheet.querySelector("[data-head-back]").onclick = back;
  // 본 것으로 친다. 실패해도 다음에 다시 알린다 — 붉은 숫자가 하루 더 남을 뿐이다.
  if (unreadNotices()) api("POST", "/api/folder-notices").then(reload).then(render).catch(() => {});
}

/** 누구의 폴더를 볼지 고른다 */
async function openWhose() {
  try { await loadFriends(); } catch (e) { toast(e.message); return; }
  /* 볼 수 있는 사람만 보여 준다 — 나에게 공개한 폴더가 없는 친구는 눌러도 빈 화면이라
     목록에 둘 이유가 없다. "내 폴더" 도 두지 않는다: 돌아가는 길은 폴더 탭 머리줄의
     "내 폴더" 버튼이고, 같은 일을 하는 자리가 둘이면 어느 쪽을 눌러야 하는지 헷갈린다. */
  const open = friends.filter(f => f.sharedFolders > 0);
  let query = "";

  const rows = () => {
    const q = query.trim().toLowerCase();
    const list = q ? open.filter(f => f.displayName.toLowerCase().includes(q)) : open;
    if (!list.length) {
      return `<div class="empty">${q ? "찾는 이름이 없습니다."
        : "폴더를 공개한 친구가 아직 없습니다.<br>왼쪽 메뉴의 친구에서 초대 링크를 보내보세요."}</div>`;
    }
    /* 별은 여기서 켜고 끄지 않는다 — 보여 주기만 한다. 같은 스위치가 여러 화면에 있으면
       어디서 켠 것인지 헷갈린다. 순서는 서버가 이미 별 켠 사람을 위로 올려 준다. */
    return list.map(f => `<button class="uf-item" data-go-friend="${esc(f.id)}">
      <span class="ub"><b>${f.starred ? `<i class="star-on">${icon("star", "on")}</i> ` : ""}${esc(f.displayName)}</b>
        <span>나에게 공개한 폴더 ${f.sharedFolders}개</span></span>
      ${viewing?.id === f.id ? `<span class="wnow">보는 중</span>` : `<span class="chev">${icon("right")}</span>`}</button>`).join("");
  };

  openSheet(`
    ${headHtml("폴더 바꾸기", { back: false, actions: false,
      sub: "친구가 나에게 공개한 폴더를 폴더 탭에서 볼 수 있습니다." })}
    ${open.length > 4 ? searchHtml("이름으로 찾기") : ""}
    <div class="fr-list" data-whose-list>${rows()}</div>`);

  const qEl = sheet.querySelector(".arch-q");
  if (qEl) qEl.addEventListener("input", () => {
    query = qEl.value;                     // 목록만 갈아 끼워 치던 자리를 지킨다
    sheet.querySelector("[data-whose-list]").innerHTML = rows();
  });

  sheet.querySelector("[data-whose-list]").addEventListener("click", guard(async e => {
    const b = e.target.closest("[data-go-friend]"); if (!b) return;
    const d = await api("GET", `/api/friends/${b.dataset.goFriend}/shared`);
    viewing = { id: d.friend.id, name: d.friend.displayName,
                folders: d.folders, works: d.works, platforms: d.platforms };
    closeSheet(); tab = "lib"; render();
  }));
}

/** 친구 폴더 안 — 보기만 하고, 마음에 들면 내 목록으로 담는다 */
function openFriendFolder(fid) {
  const f = viewing?.folders.find(x => x.id === fid); if (!f) return;
  const items = viewing.works.filter(w => w.folders.includes(fid));
  const plat = id => viewing.platforms[id] ?? { name: "링크", color: "#655A61" };
  /* 주인이 허락한 만큼만 보여 준다. 눌러 봐야 막히는 버튼을 띄우느니 아예 두지 않는다.
     서버도 같은 잣대로 한 번 더 거른다 — 화면이 유일한 빗장이면 빗장이 아니다. */
  const mayCopy = canCopy(f.take), mayMirror = canMirror(f.take);
  const already = folders.find(x => x.mirror?.owner === viewing.id && x.mirror?.folder === fid);

  openSheet(`
    ${items.length && (mayCopy || mayMirror) ? `<div class="link-row">
        ${mayCopy ? `<button class="btn primary" data-take-folder>담아가기</button>` : ""}
        ${mayMirror ? `<button class="btn${mayCopy ? "" : " primary"}" data-mirror-folder${
          already ? " disabled" : ""}>${already ? "이미 미러링 중" : "미러링"}</button>` : ""}
      </div>
      <div class="rest" style="text-align:left;padding:0 2px 10px">${
        mayCopy && mayMirror ? "담아가면 한 벌 떠 와서 내가 고칠 수 있고, 미러링은 비추기만 해서 "
          + esc(viewing.name) + "님이 고치면 나에게도 바뀝니다."
          : mayCopy ? "한 벌 떠 옵니다. 그 뒤로는 " + esc(viewing.name) + "님이 고쳐도 내 것은 그대로입니다."
            : esc(viewing.name) + "님의 폴더를 그대로 비춥니다. 내가 고칠 수는 없습니다."}</div>`
      : items.length ? `<div class="rest" style="text-align:left;padding:0 2px 10px">${
          esc(viewing.name)}님이 이 폴더를 가져가는 것은 막아 두었습니다. 보기만 할 수 있어요.</div>` : ""}
    ${items.length
      ? items.map(w => `<button class="row" data-fw="${esc(w.id)}">
          <span class="thumb" style="${coverStyle(w)}">${coverChar(w)}</span>
          <span class="rt"><b>${esc(w.title)}</b><span>${esc(plat(w.platformId).name)}</span></span>
          <span class="pdot" style="background:${plat(w.platformId).color}"></span></button>`).join("")
      : `<div class="empty">이 폴더는 비어 있습니다.</div>`}`, {
    full: true,
    title: `${f.emoji} ${esc(f.name)}`,
    sub: `${esc(viewing.name)}님의 폴더 · ${items.length}개`,
  });

  /* 폴더째 담아가기 — 폴더와 그 안의 작품을 **한 벌 떠 온다**. 떠 온 뒤로는 서로 상관이
     없어서, 내가 고쳐도 친구 것은 그대로고 친구가 새로 넣어도 나에게는 오지 않는다.
     지우는 일이 아니라 늘리는 일이므로 되묻는 창도 붉지 않다. */
  const takeF = sheet.querySelector("[data-take-folder]");
  if (takeF) takeF.onclick = guard(async () => {
    const yes = await askSure({
      title: `이 폴더를 담아갈까요?`,
      body: `${esc(f.name)} · 작품 ${items.length}편이 함께 담깁니다.
        담아간 뒤로는 ${esc(viewing.name)}님이 폴더를 고쳐도 내 것은 그대로입니다.`,
      ok: "담아가기", danger: false, back: () => openFriendFolder(fid),
    });
    if (!yes) return;
    const r = await api("POST", `/api/friends/${viewing.id}/take`, { folder: fid });
    await reload(); render();
    closeSheet();
    toast(r.already
      ? `«${r.name}» 담았습니다 — ${r.added}편 · 이미 있던 ${r.already}편도 이 폴더에 넣었습니다`
      : `«${r.name}» 담았습니다 — ${r.added}편`);
  });

  /* 미러링 — 폴더 한 줄만 만든다. 작품은 베끼지 않으므로 "몇 편 담았다" 가 아니라
     "몇 편이 비쳐 온다" 다. 그 수는 주인이 고칠 때마다 달라진다. */
  const mirrorF = sheet.querySelector("[data-mirror-folder]");
  if (mirrorF) mirrorF.onclick = guard(async () => {
    const yes = await askSure({
      title: "이 폴더를 미러링할까요?",
      body: `${esc(f.name)} · 지금 ${items.length}편. 내 폴더 탭에 그대로 비칩니다.
        ${esc(viewing.name)}님이 넣거나 빼면 나에게도 바뀌고, 나는 고칠 수 없습니다.`,
      ok: "미러링", danger: false, back: () => openFriendFolder(fid),
    });
    if (!yes) return;
    const r = await api("POST", `/api/friends/${viewing.id}/mirror`, { folder: fid });
    if (r.already) { toast(`«${r.name}» 은(는) 이미 비추고 있습니다`); return; }
    await reload(); render();
    closeSheet();
    toast(`«${r.name}» 미러링 시작 — ${r.count}편`);
  });

  sheet.querySelector(".sheet-body").addEventListener("click", e => {
    const t = e.target.closest("[data-fw]"); if (!t) return;
    const w = items.find(x => x.id === t.dataset.fw);
    if (w) openOthersWork(w, {                                // 폴더 위에 겹친다
      ownerId: viewing.id, ownerName: viewing.name, take: f.take,
      plats: viewing.platforms, over: () => openFriendFolder(fid),
    });
  });
}

/** 남의 작품 한 편 — 구경하고, 허락돼 있으면 담는다.

    두 자리에서 같은 창을 쓴다: 친구 폴더를 훑을 때와, **비추는 폴더 안**에서. 어느 쪽이든
    내 것이 아니라서 고칠 수 없고, 할 수 있는 일은 보러가기와 담아가기뿐이다.

    한때 줄을 누르면 곧바로 담기 화면이 열렸다. 그런데 친구 폴더를 훑는 일은 대개
    "뭘 보나" 구경하는 것이지 곧바로 담는 것이 아니어서, 들여다볼 자리가 아예 없었다.
    게다가 주소 없이 담은 항목은 담을 수도 없는데 빈 담기 창이 떠서 고장처럼 보였다.

    모양은 내 작품 창(openWork)과 같다 — 제목줄, 보러가기, 그리고 할 일 하나. */
function openOthersWork(w, opts) {
  const { ownerId, ownerName, take: takeMode, plats, over } = opts;
  const plat = plats?.[w.platformId] ?? platformOf(w.platformId);
  const linked = !!w.listUrl;
  const mayTake = linked && canCopy(takeMode);
  openSheet(`
    ${headHtml(esc(w.title), { back: false, actions: false,
      sub: `${esc(ownerName)}님의 목록` })}
    ${/* 담기 전에 **무엇인지 알 수 있어야** 한다. 고칠 수는 없으니 값만 늘어놓는다 —
         작품 설정과 같은 것들을 같은 차례로 두어 어느 쪽을 보든 같은 자리에서 읽게 한다. */""}
    <div class="ov">
      ${w.coverUrl ? `<div class="ov-cover" style="${coverStyle(w)}"></div>` : ""}
      <dl class="kv">
        <dt>플랫폼</dt><dd>${esc(plat.name)} · ${MEDIA[w.mediaType] ?? "링크"}</dd>
        <dt>연재 일정</dt><dd>${esc(schedText(w))}</dd>
        ${w.episode ? `<dt>회차</dt><dd>${esc(w.episode)}</dd>` : ""}
        <dt>담은 사람</dt><dd>${esc(ownerName)}</dd>
        <dt>담긴 때</dt><dd>${ago(w.addedAt)}</dd>
      </dl>
    </div>
    ${/* **보러가기가 테마색이다.** 내 작품 창에서도 그랬으므로, 같은 자리에 같은 무게로
         둔다 — 한쪽에서는 담기가, 한쪽에서는 보러가기가 진하면 어느 것이 이 창의 본 일인지
         매번 다시 읽어야 한다. 어느 창이든 먼저 하는 일은 「보러 가는 것」이다. */""}
    ${linked ? goHtml(w, plat, true) : ""}
    ${mayTake
      ? `<button class="btn" style="width:100%;margin-top:9px" data-take>내 목록에 담기</button>`
      : `<div class="rest" style="text-align:left;padding:9px 2px 0">${
          !linked ? "주소 없이 담은 항목입니다. 가져올 것이 제목뿐이라 담아 갈 수 없습니다."
            : `${esc(ownerName)}님이 이 폴더를 가져가는 것은 막아 두었습니다. 보기만 할 수 있어요.`}</div>`}
  `, { over });

  wireGo(w);
  /* 눌러 봤으면 붉은 점을 끈다. 남의 작품이라 그 줄에는 못 적고 **내 쪽 기록**에 남는다. */
  if (!w.visits) {
    w.visits = 1;
    for (const el of document.querySelectorAll(`.work[data-id="${w.id}"]`)) el.classList.remove("unseen");
    api("POST", `/api/works/${w.id}/seen`).catch(() => {});
  }
  const take = sheet.querySelector("[data-take]");
  /* 곧바로 담는다. 한때 URL 추가 창으로 넘겼는데, 그러면 **서버가 그 페이지를 다시 읽는다** —
     이미 친구 쪽에 제목·표지·플랫폼·일정이 다 있는데도. 게다가 읽기를 막는 사이트라면
     친구는 멀쩡히 갖고 있는 표지를 나는 못 받는다. 친구 것을 그대로 떠 오는 편이 빠르고 낫다.

     담고 나면 **작품 설정 창으로 이어 준다.** 떠 온 값은 친구가 정해 둔 것이라 내 사정과
     다를 수 있다 — 폴더도 아직 안 정해져 있다. 그것을 지금 손보게 하는 것이 담자마자
     다시 찾아 들어가게 하는 것보다 낫다.

     **취소하면 보던 자리로 돌아온다.** 작품 설정의 기본 되돌림은 「내 작품 창」인데, 여기서
     그것을 쓰면 친구 폴더를 보다가 난데없이 내 작품 창에 서게 된다. 돌아갈 곳을 짚어 준다. */
  if (take) take.onclick = guard(async () => {
    const r = await api("POST", `/api/friends/${ownerId}/take`, { work: w.id });
    await reload(); render();
    toast(r.already ? `«${r.title}» 은(는) 이미 담겨 있습니다` : `«${r.title}» 담았습니다`);
    /* **담긴 뒤의 모습을 보여 준다.** 이미 저장이 끝난 뒤라 곧바로 고치는 창을 여는 것은
       한 걸음 앞서간다 — 무엇이 담겼는지 먼저 보고, 고칠 것이 있으면 거기서 「설정」으로
       들어가면 된다. 남의 작품 창과 같은 모양이라 눈이 옮겨 갈 자리도 그대로다.

       `over` 는 이 창이 덮고 있던 자리(친구 폴더)를 다시 여는 손잡이다. 그대로 넘기면
       닫았을 때 보던 자리로 돌아온다. */
    if (r.id && works.some(x => x.id === r.id)) openWork(r.id, opts.over);
    else if (opts.over) opts.over();
    else hideSheet();
  });
}

/** 이 폴더를 함께 쓰는 사람들. 주인은 명단을 고칠 수 있고, 불려 간 사람은 보기만 한다. */
async function openFolderPeople(f, back) {
  const mine = !f.mirror;                    // 내가 연 폴더인가
  if (mine) { try { await loadFriends(); } catch { /* 이름을 못 읽어도 명단은 보인다 */ } }
  const nameOf = id => (friends ?? []).find(y => y.id === id)?.displayName ?? "이름 없음";

  const rows = () => {
    if (!mine)
      return `<div class="rest" style="text-align:left;padding:2px">
        ${esc(f.mirrorOf)}님이 연 폴더입니다. 함께 쓰는 사람 명단은 그쪽에서 정합니다.</div>`;
    const list = f.people ?? [];
    if (!list.length)
      return `<div class="empty">아직 아무도 부르지 않았습니다.<br>
        아래 「＋ 더 부르기」로 함께 쓸 사람을 고르세요.</div>`;
    return `<div class="fr-list">${list.map(x => {
      const nm = nameOf(x.id);
      /* 머리글자 상자는 두지 않는다 — 바로 옆에 이름이 통째로 있어 같은 글자를
         두 번 보여 줄 뿐이고, 그만큼 줄이 두꺼워져 명단이 짧아 보인다. */
      return `<div class="uf-row" style="padding:8px 2px">
        <span class="ub" style="flex:1"><b>${esc(nm)}</b></span>
        <span class="${x.state === "ok" ? "st-ok" : "st-wait"}">${
          x.state === "ok" ? "수락함" : "대기 중"}</span>
        ${/* 끊는 것은 **주인만** 한다. 불려 간 사람이 누를 자리가 아니다 —
             나가려면 제 폴더 줄을 지우면 된다(그쪽이 leaveFolder 로 간다). */""}
        <button class="mini-btn bad" data-cut="${esc(x.id)}">연결 해제</button>
      </div>`;
    }).join("")}</div>`;
  };

  const wait = mine ? (f.people ?? []).filter(x => x.state !== "ok").length : 0;
  openSheet(`
    ${headHtml(`${f.emoji} ${esc(f.name)}`, { back: true, actions: false,
      sub: mine
        ? `함께 쓰는 사람${wait ? ` · ${wait}명이 아직 대기 중입니다` : ""}`
        : `${esc(f.mirrorOf)}님과 함께 쓰는 폴더` })}
    ${rows()}
    ${mine ? `<button class="btn" style="width:100%;margin-top:12px" data-more-people>${icon("plus")} 더 부르기</button>` : ""}`);
  sheet.querySelector("[data-head-back]").onclick = back;

  /* 명단이 바뀌면 **새로 온 값으로** 다시 그린다 — 손에 든 f 는 이미 옛 값이라,
     그대로 다시 그리면 방금 부른 사람이 안 보이고 방금 끊은 사람이 남아 있다. */
  const again = async () => {
    await reload(); render();
    const now = folders.find(x => x.id === f.id);
    if (now) openFolderPeople(now, back); else back();
  };

  const add = sheet.querySelector("[data-more-people]");
  if (add) add.onclick = () => openInviteMore(f, again, () => openFolderPeople(f, back));

  sheet.querySelector(".sheet-body").addEventListener("click", guard(async e => {
    const cut = e.target.closest("[data-cut]"); if (!cut) return;
    const who = nameOf(cut.dataset.cut);
    const yes = await askSure({
      title: `${who}님의 연결을 해제할까요?`,
      body: `이 폴더를 더 볼 수 없게 되고, 넣어 둔 작품도 이 폴더에서 빠집니다.
        ${who}님에게 끊겼다는 알림이 갑니다.`,
      ok: "해제", danger: true, back: () => openFolderPeople(f, back),
    });
    if (!yes) return;
    await api("DELETE", `/api/folders/${f.id}/people/${cut.dataset.cut}`);
    toast(`${who}님의 연결을 해제했습니다`);
    await again();
  }));
}

/** 「공유자」 창에서 몇 사람을 더 부른다 — 명단을 통째로 다시 쓰지 않고 더하기만 한다 */
/** `done` 은 부르고 나서 갈 길, `back` 은 그냥 물러날 때 갈 길이다 —
    부른 뒤에는 새 명단으로 다시 그려야 하므로 둘이 다르다. */
async function openInviteMore(f, done, back) {
  try { await loadFriends(); } catch (e) { toast(e.message); return; }
  const had = (f.people ?? []).map(x => x.id);
  const out = [];
  openSheet(`
    ${headHtml("더 부르기", { back: true, save: "부르기",
      sub: `${f.emoji} ${esc(f.name)}` })}
    ${friends.length
      ? `<div data-pk></div>`
      : `<div class="empty">아직 친구가 없습니다.</div>`}`);
  sheet.querySelector("[data-head-back]").onclick = back;

  if (friends.length) friendPicker(sheet.querySelector("[data-pk]"),
    { all: friends, already: had, out });

  wireHead({
    save: guard(async () => {
      if (!out.length) { toast("부를 사람을 골라 주세요"); return; }
      const { added } = await api("POST", `/api/folders/${f.id}/people`, { add: out });
      toast(added ? `${added}명을 불렀습니다` : "이미 명단에 있는 사람입니다");
      await done();
    }),
    cancel: back,
  });
}

/** 폴더 한 줄. idx 를 주면 그것으로 세고, 안 주면 제가 훑는다 —
    목록처럼 여러 줄을 한꺼번에 그리는 곳만 색인을 만들어 넘긴다. */
function folderRow(fid, emoji, name, f, idx) {
  const all = idx ? (fid === "_all" ? activeWorks()
    : fid === "_none" ? activeWorks().filter(w => !w.folders.length)
      : idx.get(fid) ?? [])
    : worksIn(fid);
  const list = byRecent(all).slice(0, 4);
  const mini = list.length
    ? `<div class="mini">${list.map(w => `<i style="${coverStyle(w)}"></i>`).join("")}
       ${"<i></i>".repeat(Math.max(0, 4 - list.length))}</div>`
    : `<div class="mini solo">${emoji}</div>`;
  // 전체·미분류는 진짜 폴더가 아니라 설정할 것이 없다 — 그때만 화살표를 둔다
  const real = fid !== "_all" && fid !== "_none";
  return `<div class="folder-row">
    ${folderSel && real ? `<label class="arch-pick"><input type="checkbox" data-fpick="${fid}"
      ${folderSel.has(fid) ? "checked" : ""} aria-label="${esc(name)} 선택"></label>` : ""}
    <button class="folder${real && !folderSel ? " joined" : ""}" data-folder="${fid}">${mini}
      ${/* 딱지에 **누구를** 미러링하는지까지 적는다. 아래 작은 글씨를 읽지 않고 목록을
            훑는 것만으로 남의 폴더임을 알아야 한다 — 내 폴더와 한 줄로 섞여 있기 때문이다. */""}
      ${/* 함께 고치는 폴더는 **내가 연 것인지 불려 간 것인지**가 먼저 보여야 한다 —
           목록에서 둘이 나란히 서기 때문이다. */""}
      <span class="txt"><b>${emoji ? emoji + " " : ""}${esc(name)}${
        f?.mirror
          ? ` <i class="mtag">${f.canEdit ? `공유폴더 · ${esc(f.mirrorOf)}` : `미러링 · ${esc(f.mirrorOf)}`}</i>`
          : canEdit(f?.take) ? ` <i class="mtag">공유폴더 · 오너</i>` : ""}</b><span>${
        f?.broken ? esc(f.broken) : `${all.length}개`}</span></span>
      ${real ? "" : `<span class="chev">${icon("right")}</span>`}</button>
    ${/* 별은 폴더 딱지의 **오른쪽 끝에 이어 붙인다**. 딱지 자체가 button 이라 그 안에
         또 button 을 넣을 수는 없다(문법에도 어긋나고 누를 때 둘이 엉킨다). 형제로 두되
         바탕과 테두리를 같게 하고 맞닿는 쪽 모서리를 지워, 눈에는 한 덩어리로 보이게 한다. */""}
    ${real && !folderSel ? `<button class="star in-folder" data-fstar="${fid}"
      aria-pressed="${!!f?.starred}" title="즐겨찾기"
      aria-label="${esc(name)} 즐겨찾기">${icon("star", f?.starred ? "on" : "")}</button>` : ""}
  </div>`;
}

/* 보던 화면을 주소에 적어둔다 — 새로고침해도 남고, 주소만 봐도 어디인지 알 수 있다.
   서버에 저장할 성질이 아니라서 해시를 쓴다. 검색 문자열은 공유·초대가 이미 쓰고 있다. */
function readHash() {
  const [t, arg] = decodeURIComponent(location.hash.replace(/^#/, "")).split("/");
  if (t === "cal") {
    tab = "cal";
    if (arg === "month" || arg === "week") calView = arg;
    if (calView === "month" && calDay === null) calDay = midnight().getTime();
  } else if (t === "lib") {
    tab = "lib";
    // 사라진 폴더를 가리키고 있으면 목록으로 되돌린다
    openFolderId = !arg ? null
      : arg === "_all" || arg === "_none" || folders.some(f => f.id === arg) ? arg : null;
  } else {
    // 화면 이름은 캘린더·페이지·폴더이지만 주소의 열쇠는 그대로 둔다 —
    // 이미 저장해 둔 주소가 깨지지 않게. 아무것도 없으면 캘린더로 연다.
    tab = t === "home" ? "home" : "cal";
  }
}

function writeHash() {
  const h = tab === "lib" ? (openFolderId ? `lib/${openFolderId}` : "lib")
    : tab === "home" ? "home"
      : `cal/${calView}`;
  if (location.hash.replace(/^#/, "") !== h)
    history.replaceState(null, "", `${location.pathname}#${h}`);
}

function render() {
  writeHash();
  for (const [id, t] of [["tab-cal", "cal"], ["tab-home", "home"], ["tab-lib", "lib"]])
    document.getElementById(id).setAttribute("aria-selected", tab === t);

  let html = "";
  if (tab === "cal") {
    html = renderCalendar();
  } else if (tab === "home") {
    html += `<div class="screen-title">최근 본 순 · 플랫폼별</div>`;
    html += railsHtml(byRecent(activeWorks()));
  } else if (viewing) {
    // 친구의 폴더 — 보기만 한다. 고치거나 지우는 것은 주인만 할 수 있다.
    /* 친구 폴더도 줄마다 두 번 훑고 있었다(미리보기 · 개수). 한 번 훑어 갈라 둔다 —
       내 폴더 목록과 같은 이치다. */
    const frIdx = new Map();
    for (const w of viewing.works)
      for (const id of w.folders) {
        let a = frIdx.get(id);
        if (!a) frIdx.set(id, a = []);
        a.push(w);
      }
    html += whoseBar() + `<div class="folders">`;
    html += viewing.folders.length
      ? viewing.folders.map(f => {
        const all = frIdx.get(f.id) ?? [];
        const list = all.slice(0, 4);
        // 내 폴더 줄과 같은 모양 — 표지가 있으면 표지를, 없으면 아이콘 하나를 보여 준다
        const mini = list.length
          ? `<div class="mini">${list.map(w => `<i style="${coverStyle(w)}"></i>`).join("")}
             ${"<i></i>".repeat(Math.max(0, 4 - list.length))}</div>`
          : `<div class="mini solo">${f.emoji}</div>`;
        return `<button class="folder" data-fr-folder="${esc(f.id)}">${mini}
          <span class="txt"><b>${f.emoji} ${esc(f.name)}</b><span>${all.length}개</span></span>
          <span class="chev">${icon("right")}</span></button>`;
      }).join("")
      : `<div class="empty">${esc(viewing.name)}님이 나에게 공개한 폴더가 없습니다.</div>`;
    html += `</div>`;
  } else {
    // 고르는 중에는 진짜 폴더만 남긴다 — 전체·미분류·새 폴더는 지울 수 있는 것이 아니다
    html += whoseBar() + kindChips() + folderBar() + `<div class="folders">`;
    // 이 판에 세울 줄이 모두 함께 쓴다 — 줄마다 작품 전체를 훑지 않게
    const idx = folderIndex();
    /* 🗂 전체와 🫙 미분류는 폴더가 아니라 **모든 작품을 보는 길**이다. 갈래를 좁힌
       화면에 그것들이 서 있으면 "일반 폴더" 를 골랐는데 전부가 나오는 셈이라 어긋난다. */
    if (!folderSel && fkind === "all") {
      html += folderRow("_all", icon("grid"), "전체", undefined, idx);
      if (activeWorks().some(w => !w.folders.length))
        html += folderRow("_none", icon("inbox"), "미분류", undefined, idx);
    }
    const list = kindShown();
    html += list.map(f => folderRow(f.id, f.emoji, f.name, f, idx)).join("");
    if (!list.length) html += `<div class="empty">이 갈래의 폴더가 없습니다.</div>`;
    // 새 폴더는 늘 만들 수 있다 — 갈래는 보는 방식일 뿐이지 만들 수 있는 것을 가르지 않는다
    if (!folderSel) html += `<button class="folder ghost" data-new-folder>${icon("plus")} 새 폴더</button>`;
    html += `</div>`;
  }

  screenEl.innerHTML = html;
  const n = unfiled().length;
  const badge = document.getElementById("fab-badge");
  badge.textContent = n > 99 ? "99+" : n;
  badge.hidden = n === 0;
  fabEl.classList.remove("tucked");
  /* 곁창 아이콘은 캘린더에서만, 그리고 담을 것이 있을 때만 나온다 —
     빈 창을 여는 버튼은 눌러 볼 이유가 없다.

     **숫자는 붙이지 않는다.** 붉은 숫자는 "네가 해야 할 일이 이만큼 밀렸다" 는 말인데,
     여기 담기는 것은 날짜가 없는 작품들이라 재촉할 일이 아니다. 있으면 버튼이 서고
     없으면 사라지는 것만으로 충분하다 — 그 자체가 이미 "볼 것이 있다" 는 표다. */
  const idleN = tab === "cal" ? idleTotal() : 0;
  idleEl.hidden = !idleN;
  idleEl.classList.remove("tucked");

  /* 🔔 은 늘 자리에 있다. 떠 있는 버튼이 아니라 **붙박이**라, 없어졌다 생겼다 하면
     그때마다 옆의 것들이 밀린다. 대신 붉은 숫자는 있을 때만 붙는다.

     종은 화면 너비에 따라 **상단바에도, 사이드 메뉴에도** 설 수 있다. 어느 쪽이 서는지는
     CSS가 정하고 여기서는 세 자리에 같은 숫자를 적어 둔다 — 자바스크립트가 너비를 재서
     가르면 창을 줄였다 늘릴 때마다 어긋난다.

     메뉴 버튼(☰)의 숫자는 좁은 화면 몫이다: 종이 메뉴 안으로 들어가면 열어 보기 전에는
     소식이 온 줄을 알 수 없다. 넓은 화면에서는 CSS가 그 숫자를 감춘다. */
  const bn = unreadNotices();
  for (const id of ["bell-badge", "menu-bell-badge", "menu-badge"]) {
    const el = document.getElementById(id);
    el.textContent = bn > 99 ? "99+" : bn;
    el.hidden = !bn;
  }
  /* 게스트는 친구가 없어 끊길 줄도 없다 — 영영 빈 종을 달아 두지 않는다.
     처음부터 안 보이므로 옆의 것들이 밀리는 일도 없다. */
  for (const id of ["btn-bell", "menu-bell"])
    document.getElementById(id).hidden = guestMode();

  /* 폴더 초대는 **폴더 탭에서, 받은 것이 있을 때만** 나온다 — 없는데 자리를 차지하면
     눌러 봐야 빈 창이다. */
  const fiN = tab === "lib" && !viewing ? folderInvites.length : 0;
  fiEl.hidden = !fiN;
  fiEl.classList.remove("tucked");
  const fb = document.getElementById("fi-badge");
  fb.textContent = fiN > 99 ? "99+" : fiN;
  fb.hidden = !fiN;
  // 안쪽이 구를 때는 내용을 갈아 끼우면 저절로 맨 위가 됐다 — 문서가 구를 땐 직접 올린다
  toTop();
  lastScrollY = 0;
  fitWeek();
  measureUnknownCovers();
}

/* 비율을 알려주지 않는 사이트가 많다. 브라우저는 어차피 이미지를 받으므로
   그때 크기를 재서 가로 이미지면 잘라내지 않게 바꾸고, 다음부터 안 재도록 서버에 남긴다. */
const measured = new Set();
/* 비율 재기는 **한 번에 넷씩**만 한다.

   한때 화면에 있는 표지를 통째로 걸어 두었다. 그러면 그림 하나가 두 번씩 불린다 —
   배경으로 한 번, 재려고 또 한 번 — 그런 요청이 수십 개가 한꺼번에 나간다. 브라우저는
   한 서버에 여섯 줄쯤만 열어 두므로 나머지는 줄을 서고, 그동안 화면에 보여야 할 표지가
   뒤로 밀려 **그리다 만 것처럼** 보였다.

   재는 일은 급하지 않다 — 다음에 열 때까지 안 끝나도 그만이고, 한 번 재면 서버에 남아
   두 번 재지 않는다. 그래서 그리기에 자리를 내주고 천천히 뒤따라간다. */
const MEASURE_AT_ONCE = 4;
let measuring = 0;
const toMeasure = [];

function measureNext() {
  while (measuring < MEASURE_AT_ONCE && toMeasure.length) {
    const id = toMeasure.shift();
    const w = works.find(x => x.id === id);
    if (!w?.coverUrl || w.coverAspect) continue;
    measuring++;
    const img = new Image();
    const done = () => { measuring--; measureNext(); };
    img.onload = () => {
      const a = img.naturalWidth / img.naturalHeight;
      if (Number.isFinite(a) && a > 0) {
        w.coverAspect = a;
        if (a > WIDE)
          for (const e of document.querySelectorAll(`[data-id="${id}"] .cover, [data-id="${id}"] .thumb`))
            e.style.backgroundSize = "contain";
        api("PATCH", `/api/works/${id}`, { coverAspect: a }).catch(() => {});
      }
      done();
    };
    // 못 읽어도 줄은 계속 흘러야 한다 — 하나가 막혔다고 나머지가 멈추면 안 된다
    img.onerror = done;
    img.src = w.coverUrl;
  }
}

function measureUnknownCovers() {
  for (const el of screenEl.querySelectorAll(".cover, .thumb")) {
    const id = el.closest("[data-id]")?.dataset.id;
    if (!id || measured.has(id)) continue;
    const w = works.find(x => x.id === id);
    if (!w?.coverUrl || w.coverAspect) continue;
    if (w.mirror) continue;               // 남의 작품이라 고쳐 둘 곳이 없다
    measured.add(id);
    toMeasure.push(id);
  }
  /* 화면이 먼저 그려지고 나서 시작한다 — 같은 그림을 배경으로 부르는 요청이 이미
     줄에 서 있는데 그 앞에 끼어들면 바로 그 밀림이 생긴다. */
  requestAnimationFrame(() => setTimeout(measureNext, 120));
}

/* ── 시트 ────────────────────────────────────────────────── */
const back = document.getElementById("sheet-back"), sheet = document.getElementById("sheet");
/* 목록 위에 작품 화면을 겹쳐 열 때, 닫으면 목록으로 돌아가야 한다.
   화면을 통째로 담아 두면 붙여 둔 동작들이 죽으므로 **다시 여는 함수**를 담는다. */
let sheetBack = [];

/** 창을 화면에서 걷는다 — 아래에 쌓아 둔 것은 보지 않는다.
    되묻는 창처럼 "이 창만 치우고 다음은 부른 쪽이 정한다" 는 자리에서 쓴다. */
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function hideSheet() {
  // 커서가 남아 있으면 창이 사라진 뒤에도 키보드가 떠 있다
  document.activeElement?.blur?.();
  if (!back.hidden) lockScroll(false);
  back.hidden = true;
  // 폴더 팝업은 주소에도 남아 있다 — 닫으면 같이 비운다
  if (openFolderId !== null) { openFolderId = null; writeHash(); }
  /* 골라 둔 작품도 여기서 버린다. 창을 닫는 것은 **하던 일을 그만두는 것**이라,
     같은 폴더를 다시 열었을 때 지난번에 고른 것이 그대로 켜져 있으면 안 된다 —
     골라 둔 줄 모르고 「휴지통」을 누르게 된다. */
  workSel = null; workSelKey = null;
  sheet.className = "sheet";
  sheet.style.transform = ""; sheet.style.transition = "";
  sheet.innerHTML = "";
}

const closeSheet = () => {
  const prev = sheetBack.pop();
  if (prev) return prev();          // 아래 시트로 되돌아간다 — 창은 계속 열려 있다
  hideSheet();
};
/* 배경을 눌러 닫는다. 시트 자체를 누른 것은 그대로 흘려보낸다.

   한때 이 자리에 touchstart · touchend · pointerdown/up 을 손으로 엮어 두었다.
   아이폰에서 배경 톡이 한 번에 안 먹는다고 짐작해 덧붙인 것인데, 손짓 사이에 상태가
   남아 **시트 안 버튼이 안 눌리는** 더 큰 탈을 냈다. 전부 걷어내고 click 하나로 돌아왔다. */
back.addEventListener("click", e => { if (e.target === back) closeSheet(); });
// 시트 안쪽은 매번 새로 그려지므로 닫기는 시트 자체에 한 번만 위임해 둔다
sheet.addEventListener("click", e => { if (e.target.closest("[data-close]")) closeSheet(); });


/* 저장이 있는 시트의 머리줄. 제목과 함께 **취소·저장**을 들고 있고, 스크롤해도 붙어 있는다
   (styles.css 의 .crumb 참고). 어느 창이든 같은 자리에 같은 버튼이 있어야 매번 찾지 않는다.

   버튼이 놓이는 자리는 기기에 따라 갈린다 — 마우스가 있으면 시트 맨 아래 버튼줄,
   손가락이면 여기 오른쪽 끝. 둘 중 하나만 보인다. */
function headHtml(title, opts = {}) {
  const { back = true, save = "저장", cancel = "취소", sub = "", actions = true } = opts;
  return `<div class="crumb">
      ${back ? `<button data-head-back aria-label="돌아가기">${icon("left")}</button>` : ""}
      <h3>${title}</h3>
      ${actions ? `<span class="crumb-act">
        <button class="mini-btn" data-cancel>${cancel}</button>
        <button class="mini-btn on" data-done>${save}</button>
      </span>` : ""}</div>${sub ? `<p class="sub">${sub}</p>` : ""}`;
}

/** 머리줄과 아래 버튼줄을 한꺼번에 잇는다 — 같은 일을 하는 버튼이 두 자리에 있다. */
function wireHead({ save, cancel, back = cancel }) {
  /* 같은 일을 하는 버튼이 두 자리(머리줄 · 아래 버튼줄)에 있다. 저장이 서버를 기다리는
     동안 **둘 다** 잠가야 한다 — 하나만 잠그면 다른 하나로 또 누를 수 있고, 폴더 만들기처럼
     누른 만큼 만들어지는 자리에서는 그대로 사고가 된다. */
  const acts = [...sheet.querySelectorAll("[data-done], [data-cancel], [data-head-back]")];
  let busy = false;
  const held = fn => async (...a) => {
    if (busy) return;
    busy = true;
    for (const b of acts) b.disabled = true;
    try { await fn(...a); } catch (e) { toast(e.message); }
    finally { busy = false; for (const b of acts) if (b.isConnected) b.disabled = false; }
  };
  const onSave = held(save), onCancel = held(cancel), onBack = held(back);
  for (const b of sheet.querySelectorAll("[data-done]")) b.onclick = onSave;
  for (const b of sheet.querySelectorAll("[data-cancel]")) b.onclick = onCancel;
  const bk = sheet.querySelector("[data-head-back]");
  if (bk) bk.onclick = onBack;
}

/* 기본은 아래에서 올라오는 낮은 시트. 목록이 긴 화면은 full로 띄운다 —
   손잡이 대신 제목줄과 닫기 버튼이 고정되고 본문만 스크롤된다. */
function openSheet(html, opts = {}) {
  /* flush 는 **통의 위 여백을 떼는** 갈래다. 붙는 머리글(sticky)이 통 맨 위에 닿아야
     하는 화면에서 쓴다 — 여백이 남아 있으면 지나가는 줄이 그 틈으로 비친다. */
  sheet.className = (opts.full ? "sheet full" : "sheet") + (opts.flush ? " flush" : "");
  // 손잡이는 모든 시트에 둔다 — 어느 창이든 같은 자리를 잡아 끌어 내리면 닫힌다.
  // 그래서 닫기 버튼은 없앴다. 배경을 눌러도, Esc 를 눌러도 닫힌다.
  /* 닫기 버튼은 마크업에 늘 넣어 두고, **보일지는 CSS가 정한다** (마우스가 있는 기기에서만).
     화면 너비로 가르면 큰 태블릿에서 마우스도 없는데 나오고, 창을 줄인 데스크톱에서는
     사라진다. 창 크기가 바뀌어도 알아서 맞아야 한다. */
  /* 시트 맨 위의 붙어 있는 영역. 손잡이 · 닫기 버튼 · 제목줄이 **한 통 안에** 있다.

     한때 손잡이 줄과 제목줄을 따로 붙여 두고 제목줄의 top 을 손잡이 높이(24px)만큼 내려
     맞췄는데, 그건 손잡이 높이가 바뀌면 그대로 어긋나는 숫자였다. 하나로 묶으면 바탕색도
     테두리도 한 번만 주면 되고, 서로 어긋날 자리가 없다.

     손잡이는 모든 시트에 둔다 — 어느 창이든 같은 자리를 잡아 끌어 내리면 닫힌다.
     닫기 버튼은 마우스가 있는 기기에서만 보인다 (styles.css). */
  const top = inner => `<div class="sheet-top">
      <div class="handle-zone"><div class="handle"></div></div>
      <button class="sheet-x" data-close type="button" aria-label="닫기" title="닫기">${icon("x")}</button>
      ${inner}
    </div>`;

  /* 낮은 시트든 전체 화면이든 **같은 모양**이다 — 머리(.sheet-top)와 본문(.sheet-body).
     한때 낮은 시트만 시트 자체가 구르고 머리를 sticky 로 붙여 두었는데, 같은 물건에 두
     구조가 있으니 한쪽에서만 어긋나는 일이 이어졌다 (머리 위 8px 틈으로 내용이 비치고,
     닫기 버튼이 스크롤과 함께 사라지고, 머리줄 top 을 손잡이 높이만큼 손으로 맞추고…).
     하나로 합치면 그 자리가 통째로 없어진다. */
  sheet.innerHTML = top(opts.full
      ? `<div class="sheet-head">
           <div class="sh-t"><h3>${opts.title ?? ""}</h3>
             ${opts.sub ? `<p class="sub">${opts.sub}</p>` : ""}</div>
         </div>`
      : "")
    + `<div class="sheet-body">${html}</div>`;

  /* 낮은 시트의 제목줄은 각 화면이 제 본문 첫머리에 그린다 — 부르는 쪽 모양을 바꾸지 않고
     그린 뒤에 머리 영역으로 옮긴다. 본문 안쪽에 따로 있는 제목줄(날짜 미지정의 묶음 제목
     같은 것)은 함께 굴러야 하므로 **본문의 첫 자식일 때만** 집는다. */
  if (!opts.full) {
    const cr = sheet.querySelector(".sheet-body > .crumb:first-child");
    if (cr) sheet.querySelector(".sheet-top").append(cr);
  }
  // over 가 있으면 이 시트는 그 위에 겹친 것이다. 없으면 새 흐름이라 쌓인 것을 비운다.
  if (opts.over) sheetBack.push(opts.over); else sheetBack = [];
  sheet.style.transform = "";     // 지난번 드래그 자국이 남지 않게
  if (back.hidden) lockScroll(true);
  back.hidden = false;
}

/* 아래로 끌어 닫는다. 손잡이뿐 아니라 **시트 어디를 잡아도** 된다 —
   손잡이만 잡히던 때는 겨냥이 까다로웠다.

   시트 안쪽은 스크롤되므로 두 가지가 겹치지 않게 가른다.
   ① 스크롤이 맨 위에 있을 때만 시작한다 — 목록을 올려 보다 창이 닫히면 곤란하다.
   ② 세로로 8px 넘게 움직여야 드래그로 친다. 그 안에서 손을 떼면 그냥 누른 것이다.
   글자를 고르거나 값을 넣는 칸에서는 아예 시작하지 않는다 — 거기선 끄는 뜻이 다르다. */
{
  const CLOSE_AT = 90;            // 이만큼 내리면 닫는다
  const SLOP = 8;                 // 여기까지는 '누른 것'
  let sy = 0, sx = 0, dy = 0, scroller = null, on = false, dragged = false, onGrip = false;

  // 어느 시트든 구르는 통은 본문 하나다
  const scrollerOf = () => sheet.querySelector(".sheet-body");

  sheet.addEventListener("pointerdown", e => {
    // 아래 되돌아가는 길에서도 지워야 한다 — 끌고 나서 눌린 것이 없으면 표시가 남아
    // 그다음에 진짜로 누른 것이 대신 먹힌다
    dragged = false;
    if (e.button !== 0) return;
    // 가로로 미는 목록 위에서는 시작하지 않는다 — 옆으로 밀다 창이 닫히면 곤란하다
    if (e.target.closest("input, textarea, select, [contenteditable], .rail")) return;
    scroller = scrollerOf();
    // 머리 영역(손잡이 · 닫기 · 제목줄)은 목록을 내려 본 뒤에도 잡힌다 — 닫으라고 있는 자리다
    onGrip = !!e.target.closest(".sheet-top");
    sy = e.clientY; sx = e.clientX; dy = 0; on = false;
  });

  sheet.addEventListener("pointermove", e => {
    if (scroller === null) return;
    const gy = e.clientY - sy;
    if (!on) {
      /* 목록을 내려 본 상태면 드래그가 아니라 스크롤이다 — 머리 영역을 잡았을 때는 빼고.
         맨 위인지 볼 때 1px 여유를 둔다: 화면 배율이나 관성 스크롤 때문에 0.5 같은 값이
         남아 있으면, 눈으로는 맨 위인데 드래그가 안 먹는다. */
      if (!onGrip && scroller.scrollTop > 1) { scroller = null; return; }
      // 가로로 더 갔으면 가로 슬라이드다 (페이지 탭의 카드 줄 같은 것)
      if (Math.abs(e.clientX - sx) > Math.abs(gy)) { scroller = null; return; }
      if (gy < SLOP) return;
      on = true; dragged = true;
      sheet.style.transition = "none";
      sheet.classList.add("dragging");
      // 손가락이 시트 밖으로 나가도 계속 따라오게 붙잡는다 — 실패해도 드래그 자체는 된다
      try { sheet.setPointerCapture(e.pointerId); } catch {}
    }
    dy = Math.max(0, gy);                          // 위로는 안 끌린다
    sheet.style.transform = `translateY(${dy}px)`;
  });

  const end = () => {
    scroller = null;
    if (!on) return;
    on = false;
    const far = dy > CLOSE_AT;
    sheet.classList.remove("dragging");
    sheet.style.transition = "transform .18s ease-out";
    if (!far) { sheet.style.transform = ""; return; }
    sheet.style.transform = `translateY(${sheet.offsetHeight}px)`;
    setTimeout(closeSheet, 170);
  };
  sheet.addEventListener("pointerup", end);
  sheet.addEventListener("pointercancel", end);

  // 끌고 나면 손을 뗀 자리의 버튼이 눌린 것으로 처리된다 — 그 한 번만 막는다
  sheet.addEventListener("click", e => {
    if (!dragged) return;
    dragged = false;
    e.stopPropagation(); e.preventDefault();
  }, true);
}

/* 가로 슬라이드는 손가락으로는 그냥 밀리지만, 마우스로는 밀 길이 없었다 — 휠을 옆으로
   굴리거나 Shift+휠을 알아야 했다. 마우스로 잡아끌면 따라오게 한다.

   손가락은 브라우저가 이미 굴려 주므로 **마우스일 때만** 다룬다. 두 벌이 겹치면 서로 싸운다.
   8px 넘게 움직여야 미는 것으로 치고, 그 뒤에 오는 클릭 한 번은 삼킨다 —
   밀었는데 카드가 열리면 곤란하다. */
{
  let rail = null, x0 = 0, left0 = 0, dragged = false;

  document.addEventListener("pointerdown", e => {
    dragged = false;                       // 손짓마다 새로 잡는다
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const r = e.target.closest(".rail");
    if (!r || r.scrollWidth <= r.clientWidth) return;   // 넘치지 않으면 밀 것도 없다
    rail = r; x0 = e.clientX; left0 = r.scrollLeft;
  });

  document.addEventListener("pointermove", e => {
    if (!rail) return;
    const dx = e.clientX - x0;
    if (!dragged) {
      if (Math.abs(dx) < 8) return;
      dragged = true;
      rail.classList.add("dragging");
      try { rail.setPointerCapture(e.pointerId); } catch { /* 못 잡아도 미는 데는 지장 없다 */ }
    }
    rail.scrollLeft = left0 - dx;
    e.preventDefault();                    // 글자가 파랗게 잡히지 않게
  });

  const end = () => { rail?.classList.remove("dragging"); rail = null; };
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);

  document.addEventListener("click", e => {
    if (!dragged) return;
    dragged = false;
    if (e.target.closest(".rail")) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}

/* 월간 달력은 **옆으로 밀어** 달을 넘긴다. 화살표는 그대로 두되, 달력을 넘기는 일은
   손으로 종이를 넘기는 일에 가깝다.

   세로로 읽는 것과 겹치지 않게 가른다 — 10px 넘게 움직였을 때 **가로가 세로보다 크면**
   그때만 가져온다. CSS 의 touch-action: pan-y 가 짝을 이룬다: 세로 굴리기는 브라우저에
   맡기고 가로만 우리가 받는다. 둘 다 우리가 하면 손맛이 무거워진다.

   손을 절반만 따라간다. 끝까지 따라오면 다음 달이 벌써 온 것처럼 보이는데, 놓으면
   제자리로 돌아오므로 거짓말이 된다. */
{
  const COMMIT = 60;              // 이만큼 밀어야 넘어간다
  const SLOP = 10;                // 여기까지는 '누른 것'
  let grid = null, x0 = 0, y0 = 0, dx = 0, on = false, swiped = false;

  screenEl.addEventListener("pointerdown", e => {
    swiped = false;
    if (e.button !== 0) return;
    const g = e.target.closest(".mon-grid");
    if (!g) return;
    grid = g; x0 = e.clientX; y0 = e.clientY; dx = 0; on = false;
  });

  screenEl.addEventListener("pointermove", e => {
    if (!grid) return;
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (!on) {
      if (Math.abs(mx) < SLOP) return;
      if (Math.abs(my) > Math.abs(mx)) { grid = null; return; }   // 세로로 읽는 중이다
      on = true; swiped = true;
      grid.classList.add("swiping");
      // 손가락이 달력 밖으로 나가도 계속 따라오게 붙잡는다
      try { grid.setPointerCapture(e.pointerId); } catch {}
    }
    dx = mx;
    grid.style.transform = `translateX(${dx * 0.45}px)`;
    grid.style.opacity = String(1 - Math.min(0.45, Math.abs(dx) / 520));
  });

  const end = () => {
    const g = grid;
    grid = null;
    if (!g || !on) return;
    on = false;
    g.classList.remove("swiping");
    if (Math.abs(dx) < COMMIT) {           // 덜 밀었다 — 제자리로 (전이가 되돌린다)
      g.style.transform = ""; g.style.opacity = "";
      return;
    }
    // 왼쪽으로 밀면 다음 달. 넘어가면 화면을 새로 그리므로 이 요소는 사라진다.
    moveMonth(dx < 0 ? 1 : -1);
  };
  screenEl.addEventListener("pointerup", end);
  screenEl.addEventListener("pointercancel", end);

  // 밀고 나서 손을 뗀 자리의 날짜가 눌린 것으로 처리된다 — 그 한 번만 막는다
  screenEl.addEventListener("click", e => {
    if (!swiped) return;
    swiped = false;
    if (e.target.closest(".mon-grid")) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}

/* 고른 그림을 긴 변 `max` 픽셀로 줄여 JPEG 로 만든다. 서버에 이미지 라이브러리를 들이지
   않으려고 화면에서 한다 — 어차피 브라우저가 이미 그림을 읽을 줄 안다. */
async function shrinkImage(file, max) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  cv.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return new Promise((ok, no) =>
    cv.toBlob(b => (b ? ok(b) : no(new Error("변환 실패"))), "image/jpeg", 0.8));
}

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.querySelector(".app").append(el);
  setTimeout(() => el.remove(), 2600);
}

/* 서버를 기다리는 버튼은 그동안 눌리지 않아야 한다 — 폴더 만들기처럼
   응답이 와야 창이 닫히는 자리에서 연타하면 그만큼 만들어졌다. */
const guard = fn => {
  let busy = false;
  return async (...a) => {
    if (busy) return;
    busy = true;
    const btn = a[0] instanceof Event ? a[0].currentTarget?.closest?.("button") : null;
    if (btn) btn.disabled = true;
    try { await fn(...a); } catch (e) { toast(e.message); }
    finally { busy = false; if (btn?.isConnected) btn.disabled = false; }
  };
};

/** 되돌릴 수 없는 일을 하기 전에 한 번 더 묻는다. `await` 로 답을 받는다.

    한때 이 일을 버튼이 저 혼자 맡았다 — 누르면 글씨가 "정말 삭제할까요?" 로 바뀌고 한 번 더
    누르면 지워지는 식이었다. 지우는 자리마다 모양이 달랐고, 무엇보다 **같은 자리를 두 번
    누르는** 손짓이라 잘못 누른 사람은 두 번 다 잘못 누른다. 창을 띄우면 손이 멈춘다.

    back 은 "아니오" 를 골랐을 때 되돌아갈 화면을 다시 여는 함수다. 창 없이 화면 위에서
    바로 부른 자리(폴더 탭 같은 곳)는 넘기지 않으면 그냥 닫힌다. */
function askSure({ title, body = "", ok = "삭제", cancel = "취소", back, danger = true }) {
  return new Promise(resolve => {
    const home = back ?? closeSheet;
    let done = false;
    // 배경 톡 · 손잡이 끌기 · 닫기 버튼 — 닫는 길이 여럿이라 한곳으로 모은다
    const said = v => { if (!done) { done = true; resolve(v); } };

    openSheet(`
      <div class="crumb"><h3>${title}</h3></div>
      ${body ? `<p class="sub">${body}</p>` : ""}
      <div class="link-row sure">
        <button class="btn" data-no>${esc(cancel)}</button>
        <button class="btn ${danger ? "bad" : "primary"}" data-yes>${esc(ok)}</button>
      </div>`,
      { over: () => { said(false); home(); } });

    // "예" 다음에 갈 곳은 부른 쪽이 정한다 — 되돌아갈 자리를 미리 걷어낸다
    sheet.querySelector("[data-yes]").onclick = () => {
      if (done) return;                 // 두 번 누르면 남의 되돌아갈 자리까지 꺼낸다
      /* 되돌아갈 자리를 도로 넣어 두고(pop) 이 창만 걷는다. 부른 쪽이 하던 일을 마치면
         제 손으로 다음 화면을 연다 — 여기서 열어 주면 잠깐 스쳤다 사라진다. */
      sheetBack.pop();
      said(true);
      hideSheet();
    };
    sheet.querySelector("[data-no]").onclick = () => closeSheet();
  });
}

/* ── 보러가기 ─────────────────────────────────────────────
   내 작품이든 남의 것이든 **여는 방식은 같다.** 한때 남의 작품 창은 웹 주소만 걸어 두어,
   설정에서 "앱으로" 를 골라 두었어도 비추는 폴더에서는 늘 브라우저가 떴다. 같은 일을 두
   자리에서 따로 적어 두면 한쪽만 고치는 일이 생긴다 — 그래서 한 벌만 둔다. */

/** 앱으로 열 것인가. 설정과 앱 주소가 있느냐로 갈린다. */
const viaWeb = w => settings.openMode === "web" || !w.appUrl;

const goHtml = (w, plat, primary) => `<a class="link-btn${primary ? " primary" : ""}" id="go"
    href="${esc(viaWeb(w) ? w.listUrl : w.appUrl)}"
    ${viaWeb(w) ? 'target="_blank" rel="noopener"' : ""}>보러가기<small>${viaWeb(w)
    ? (w.appUrl ? "웹으로 (설정에서 변경)" : "웹으로") : `${esc(plat.name)} 앱으로`}</small></a>`;

/** 어디에 적을지는 서버가 정한다 — 내 작품이면 그 줄에, 남의 작품이면 **내 쪽 기록**에.
    남의 칸을 고칠 수는 없지만, 내가 언제 보러 갔는지는 내 목록의 차례를 정하는 값이다. */
function wireGo(w) {
  const el = sheet.querySelector("#go"); if (!el) return;
  el.onclick = guard(async () => {
    if (!viaWeb(w)) {
      /* 앱이 없으면 아무 일도 안 일어나므로 잠시 뒤 웹으로 넘긴다. 문제는 앱이 **떴을 때도**
         이 타이머가 돌아 웹까지 열리던 것이다. 넘기기 직전에 세 가지를 확인한다.

         ① 화면이 가려졌으면 앱이 떠 있는 것이다.
         ② 사파리는 사설 주소를 열기 전에 "…앱을 여시겠습니까?" 를 묻는다. 그 창이 떠 있는
            동안 이 문서는 포커스를 잃는다 — 묻는 중에 웹으로 넘겨 버리면 안 된다.
         ③ 앱에 다녀오면 그동안 타이머가 멈춰 있다가 돌아온 뒤에 뒤늦게 터진다.
            잰 시간이 정한 것보다 한참 지났으면 이미 앱에 다녀온 것이다. */
      const DELAY = 1600, at = Date.now();
      const t = setTimeout(() => {
        if (document.hidden || !document.hasFocus()) return;
        if (Date.now() - at > DELAY + 700) return;
        // 모바일 사파리는 사용자가 누른 직후가 아닌 window.open 을 팝업으로 막는다 —
        // 타이머 안에서 부르면 아무 데도 못 가므로 이 창을 그대로 옮긴다.
        if (narrow()) location.href = w.listUrl;
        else window.open(w.listUrl, "_blank", "noopener");
      }, DELAY);
      const cancel = () => clearTimeout(t);
      document.addEventListener("visibilitychange", cancel, { once: true });
      window.addEventListener("pagehide", cancel, { once: true });
      window.addEventListener("blur", cancel, { once: true });
    }
    closeSheet();
    await api("POST", `/api/works/${w.id}/open`);
    await reload(); render();
  });
}

/* 작품 — 볼 것인가 설정할 것인가, 두 가지만 묻는다 */
function openWork(id, over) {
  const w = works.find(x => x.id === id); if (!w) return;
  /* 눌러 본 것은 더 이상 "새로 온 것" 이 아니다 — 붉은 점을 끈다.

     마지막으로 연 때(lastAt)는 건드리지 않는다. 그건 **실제로 보러 간 때**이고 목록의
     차례를 정하는 값이라, 열어만 봐도 앞으로 튀어 오르면 차례가 뜻을 잃는다.
     화면에서 먼저 지우고 서버에는 조용히 알린다 — 실패해도 다음에 다시 알린다.
     남의 작품은 여기 오지 않는다 — 위에서 openOthersWork 로 보냈다. */
  if (!w.visits) {
    w.visits = 1;
    for (const el of document.querySelectorAll(`.work[data-id="${id}"]`)) el.classList.remove("unseen");
    api("POST", `/api/works/${id}/seen`).catch(() => {});
  }
  // 비추는 폴더 안의 작품은 내 것이 아니다 — 남의 작품 창으로 보낸다
  if (w.mirror) return openOthersWork(w, {
    ownerId: w.mirror, ownerName: w.mirrorOf, take: w.mirrorTake, over,
  });
  const p = platformOf(w.platformId);
  const linked = !!w.listUrl;    // 직접 입력한 항목에는 열 곳이 없다
  const st = STATES[w.state];
  openSheet(`
    ${headHtml(esc(w.title), { back: false, actions: false, sub: "내 목록" })}
    ${/* 남의 작품 창과 **같은 모양**이다. 한때 여기만 값을 작은 글씨 한 줄에 몰아 놓았는데,
         같은 작품을 어디서 여느냐에 따라 읽는 자리가 달라지면 매번 다시 찾아야 한다.
         값의 차례도 작품 설정과 맞춰 둔다. */""}
    <div class="ov">
      ${w.coverUrl ? `<div class="ov-cover" style="${coverStyle(w)}"></div>` : ""}
      <dl class="kv">
        <dt>플랫폼</dt><dd>${esc(p.name)}${linked ? ` · ${MEDIA[w.mediaType] ?? "링크"}` : ""}</dd>
        <dt>연재 일정</dt><dd>${esc(schedText(w))}</dd>
        ${w.episode ? `<dt>회차</dt><dd>${esc(w.episode)}</dd>` : ""}
        ${w.rating ? `<dt>별점</dt><dd><i class="stars-h">${starText(w.rating)}</i></dd>` : ""}
        ${st ? `<dt>상태</dt><dd>${icon(st.icon)} ${esc(st.label)}</dd>` : ""}
        ${/* 어느 폴더에 넣어 뒀는지. 「이걸 어디에 넣었더라」 를 알아보려고 설정을 열고
             폴더 고르개를 펼쳐 보는 일이 잦았다 — 읽기만 하면 되는 값이라 여기 적는다.
             안 넣은 것은 줄 자체를 두지 않는다: 「없음」 은 알려 주는 바가 없다. */""}
        ${(() => { const n = folderNames(w); return n ? `<dt>폴더</dt><dd>${esc(n)}</dd>` : ""; })()}
        <dt>마지막 실행</dt><dd>${ago(w.lastAt)}</dd>
      </dl>
    </div>
    ${linked ? goHtml(w, p, true)
      : `<div class="rest" style="text-align:left;padding:2px 2px 8px">
           주소 없이 담은 항목입니다. 나중에 페이지가 생기면 설정에서 주소를 붙일 수 있습니다.</div>`}
    <button class="btn" data-act="settings" style="width:100%;margin-top:9px">설정</button>
  `, { over });
  wireGo(w);
  sheet.querySelector('[data-act="settings"]').onclick = () =>
    openWorkSettings(id, { back: () => openWork(id, over) });
}

function openWorkSettings(id, opts) {
  const o = opts ?? {};
  const w = works.find(x => x.id === id); if (!w) return;
  const mode = o.mode ?? "done";
  const goBack = o.back ?? (() => openWork(id));
  // 취소로 되돌릴 원본. 재렌더 때 새로 뜨지 않도록 그대로 물려준다.
  const snap = o.snap ?? { title: w.title, schedule: structuredClone(w.schedule),
    folders: [...w.folders], color: w.color ?? null, coverUrl: w.coverUrl ?? "" };
  const draft = o.draft ?? { title: w.title, schedule: structuredClone(w.schedule),
    folders: [...w.folders], color: w.color ?? null, coverUrl: w.coverUrl ?? "" };
  const again = () => openWorkSettings(id, { ...o, mode, back: o.back, snap, draft });

  openSheet(`
    <div class="crumb"><button data-back-work aria-label="돌아가기">${icon("left")}</button><h3>작품 설정</h3>
      <span class="crumb-act">
        <button class="mini-btn" data-cancel>취소</button>
        <button class="mini-btn on" data-done>저장</button>
      </span></div>
    <p class="sub">${esc(platformOf(w.platformId).name)}</p>
    <div class="field">
      <label for="w-title">제목
        <span style="text-transform:none;letter-spacing:0">— 사이트가 준 제목이 길거나 어색하면 고쳐 쓰세요</span>
      </label>
      <input id="w-title" value="${esc(draft.title)}" placeholder="작품 제목" maxlength="120">
    </div>
    ${w.listUrl ? "" : `<div class="field">
      <label for="w-url">주소 <span style="text-transform:none;letter-spacing:0">— 나중에 페이지가 생기면</span></label>
      <input id="w-url" placeholder="https://…" spellcheck="false"></div>`}
    <div class="field"><label>표지
        <span style="text-transform:none;letter-spacing:0">— 못 받아왔거나 마음에 안 들면</span></label>
      <div class="cover-edit">
        <span class="thumb" data-cover-prev style="${coverStyle({ ...w, coverUrl: draft.coverUrl })}"
          >${draft.coverUrl ? "" : esc((draft.title || "?").slice(0, 1))}</span>
        <span class="cover-in">
          <label class="btn" style="display:block;text-align:center">사진 고르기
            <input type="file" accept="image/*" id="w-pick" hidden></label>
          <input id="w-cover" value="${esc(draft.coverUrl ?? "")}" spellcheck="false"
                 placeholder="또는 https://… 이미지 주소">
        </span>
      </div></div>
    ${schedHtml(draft.schedule, null, { value: draft.color, fallback: platformOf(w.platformId).color })}
    ${pickerHtml(draft.folders)}
    <div class="field"><label>목록에서 내리기</label>
      <div class="link-row">
        <button class="btn" data-act="watched">${icon("check")} 시리즈 감상 완료</button>
        <button class="btn" data-act="dropped">${icon("trash")} 휴지통</button>
      </div>
    </div>
    <div class="link-row wide-only" style="margin-top:4px">
      <button class="btn" data-cancel>취소</button>
      <button class="btn primary" data-done>${mode === "add" ? "설정 완료" : "저장"}</button></div>
  `);

  const titleEl = sheet.querySelector("#w-title");
  titleEl.addEventListener("input", () => { draft.title = titleEl.value; });
  wireSched(sheet, draft.schedule, redraw => { if (redraw) again(); });
  wireColorPicker(sheet, draft, platformOf(w.platformId).color);
  wirePicker(sheet, draft.folders, () => {}, () => again());

  /* 표지 주소를 치는 동안 바로 보여 준다 — 붙여넣은 주소가 그림이 맞는지 눈으로 확인해야
     한다. 주소만 보고는 알 수 없다. */
  const coverEl = sheet.querySelector("#w-cover");
  const prevEl = sheet.querySelector("[data-cover-prev]");
  const paintCover = () => {
    prevEl.style.cssText = coverStyle({ ...w, coverUrl: draft.coverUrl, coverAspect: null });
    prevEl.textContent = draft.coverUrl ? "" : (draft.title || "?").slice(0, 1);
  };
  coverEl.addEventListener("input", () => {
    draft.coverUrl = coverEl.value.trim();
    paintCover();
  });

  /* 사진을 골라 올린다. 아이폰 사파리에는 "이미지 주소 복사" 가 없어서 주소만으로는
     길이 막힌다 — 캡처해 둔 포스터를 그냥 올릴 수 있어야 한다.
     보내기 전에 화면에서 줄인다: 표지를 그리는 크기가 46~120px 라 400px 면 넉넉하고,
     원본을 그대로 두면 한 장에 몇 MB가 된다. 줄이면서 사진의 위치정보도 함께 떨어진다. */
  const pick = sheet.querySelector("#w-pick");
  pick.onchange = guard(async () => {
    const file = pick.files?.[0]; if (!file) return;
    let blob;
    try { blob = await shrinkImage(file, 400); }
    catch { toast("그림을 읽지 못했습니다"); return; }
    const r = await api("PUT", `/api/works/${id}/cover`, blob);
    draft.coverUrl = r.coverUrl;
    coverEl.value = "";                      // 주소 칸과 섞이지 않게 비운다
    paintCover();
    toast("표지를 올렸습니다");
  });

  const urlEl = sheet.querySelector("#w-url");     // 주소 없이 담은 항목에만 있다

  const commit = guard(async () => {
    const title = draft.title.trim();
    if (!title) { titleEl.focus(); return; }

    /* 주소를 새로 넣었으면 제목·표지·플랫폼을 그 페이지에서 다시 얻어야 한다.
       고쳐 담을 수는 없어서 새로 담고 옛 항목을 지운다 — 일정·폴더·색·제목은 그대로 옮긴다.
       한때 이 일을 "붙이기" 라는 따로 된 버튼이 맡았는데, 주소를 넣고 저장만 누른 사람에게는
       아무 일도 일어나지 않았다. 넣었으면 적용되는 것이 당연한 기대다. */
    const url = urlEl?.value.trim();
    if (url) {
      await api("POST", "/api/works", { url, title, schedule: draft.schedule,
        folders: draft.folders, color: draft.color, filed: true });
      await api("DELETE", `/api/works/${id}`);
      await reload(); render(); closeSheet();
      toast("주소를 붙였습니다");
      return;
    }

    await api("PATCH", `/api/works/${id}`, {
      title, schedule: draft.schedule, folders: draft.folders, color: draft.color,
      coverUrl: draft.coverUrl, filed: mode === "add" ? true : undefined,
    });
    await reload(); render(); goBack();
  });

  const cancel = () => { Object.assign(draft, structuredClone(snap)); goBack(); };
  for (const b of sheet.querySelectorAll("[data-done]")) b.onclick = commit;
  for (const b of sheet.querySelectorAll("[data-cancel]")) b.onclick = cancel;
  // 되돌아가기(‹)는 담는 중이면 취소, 고치는 중이면 저장이다 — 하던 일을 잃지 않게
  sheet.querySelector("[data-back-work]").onclick = mode === "add" ? cancel : commit;

  // 감상 완료는 별점을 물어본다 — 나중에 별점별로 모아 보기 위한 것이다.
  sheet.querySelector('[data-act="watched"]').onclick = () => openRating(w, "watched");
  /* 휴지통은 별점을 묻지 않는다 — 버리는 것에 점수를 매길 일은 없다. 대신 정말 내릴
     것인지는 묻는다. 이미 매긴 점수는 지우지 않으므로 되돌리면 그대로 살아난다. */
  sheet.querySelector('[data-act="dropped"]').onclick = guard(async () => {
    const yes = await askSure({
      title: "휴지통으로 옮길까요?", ok: "휴지통", back: again,
      body: `${esc(w.title)} 을(를) 목록에서 내립니다. 지워지지 않고 왼쪽 메뉴의 휴지통에 남습니다.`,
    });
    if (!yes) return;
    await api("PATCH", `/api/works/${id}`, { state: "dropped" });
    await reload(); render(); closeSheet();
    toast("휴지통으로 옮겼습니다");
  });
}

/* 목록에서 내릴 때 별점을 묻는다. 나중에 보관함에서 별점별로 모아 보기 위한 것이라
   건너뛸 수 있어야 한다 — 강요하면 내리기 자체를 망설이게 된다. */
/* 한 편도, 여럿도 이 창으로 온다 — 별점을 묻는 자리가 둘이면 한쪽만 고치게 된다.

   **여럿일 때 안 고르면 손대지 않는다.** 한 편일 때는 이미 매긴 점수가 초기값이라 그냥
   옮겨도 그대로 남지만, 여럿은 저마다 다른 점수를 갖고 있어 0 을 보내면 그것들이 통째로
   지워진다. 값을 아예 안 실어 보내 서버가 그 칸을 건드리지 않게 한다. */
function openRating(target, state, opts = {}) {
  const list = Array.isArray(target) ? target : [target];
  const one = list.length === 1 ? list[0] : null;
  const meta = STATES[state];
  let picked = one?.rating ?? 0;

  openSheet(`
    ${headHtml(`${icon(meta.icon)} ${meta.label}`,
      { back: false, save: `${esc(meta.label)}${ro(meta.label)} 옮기기`,
        sub: one ? esc(one.title) : `고른 ${list.length}편` })}
    <div class="field"><label>별점</label>
      <div class="stars">${Array.from({ length: MAX_STAR }, (_, i) =>
        `<button data-star="${i + 1}" aria-label="${i + 1}점">${icon("star")}</button>`).join("")}</div>
      <div class="rest" data-star-sum style="padding:4px 2px 0"></div>
    </div>
    <div class="link-row wide-only">
      <button class="btn" data-cancel>취소</button>
      <button class="btn primary" data-done>${esc(meta.label)}${ro(meta.label)} 옮기기</button>
    </div>`);

  const box = sheet.querySelector(".stars");
  const paint = n => box.querySelectorAll("[data-star]")
    .forEach(b => b.classList.toggle("on", +b.dataset.star <= n));
  const sum = () => {
    sheet.querySelector("[data-star-sum]").innerHTML =
      picked ? `${starText(picked)} ${picked}점${one ? "" : " · 고른 전부에 같은 점수"}`
        : one ? "안 매겨도 됩니다." : "안 매기면 저마다 매겨 둔 점수를 그대로 둡니다.";
  };
  paint(picked); sum();

  box.addEventListener("mouseover", e => {
    const b = e.target.closest("[data-star]"); if (b) paint(+b.dataset.star);
  });
  box.addEventListener("mouseleave", () => paint(picked));
  box.addEventListener("click", e => {
    const b = e.target.closest("[data-star]"); if (!b) return;
    const n = +b.dataset.star;
    picked = picked === n ? 0 : n;     // 같은 별을 다시 누르면 취소된다
    paint(picked); sum();
  });

  /* 별점은 안 고르면 그만이라 따로 건너뛸 버튼을 두지 않는다.
     이미 매긴 점수는 picked 의 초기값이므로 그냥 옮기면 그대로 남는다. */
  wireHead({
    save: guard(async () => {
      // 한 편이면 0 도 뜻이 있다(점수를 지운다). 여럿이면 안 고른 것은 손대지 않는다.
      const rating = picked || (one ? null : undefined);
      for (const x of list) await api("PATCH", `/api/works/${x.id}`, { state, rating });
      await reload(); render();
      if (opts.after) opts.after(); else closeSheet();
    }),
    // 취소는 아무것도 바꾸지 않고 한 걸음 뒤로 — 잘못 눌렀을 때 빠져나갈 길
    cancel: () => openWorkSettings(w.id),
  });
}

/** 목록 위의 찾기 칸. 여섯 화면이 같은 물건을 쓴다 —
    보관함 · 전체 검색 · 구간 목록 · 친구 목록 · 폴더 바꾸기 · 폴더 공개 대상.

    치는 동안 시트를 통째로 다시 그리면 커서가 빠지므로, 부르는 쪽은 늘 **목록만**
    갈아 끼운다. 그 규칙을 강제할 수는 없어도 한 자리에서 만들면 잊기는 어렵다. */
const searchHtml = (placeholder, value = "", style = "") =>
  `<input class="arch-q" type="search" placeholder="${placeholder}" value="${esc(value)}"
          autocomplete="off" spellcheck="false"${style ? ` style="${style}"` : ""}>`;

/* 친구를 골라 담는 칸. 폴더 설정의 「고른 친구에게만」과 「공유자」 창의 「더 부르기」가
   같은 물건을 쓴다 — 찾기 칸, 고르개, 담은 이름표까지 셋이 한 벌이다.

   `out` 에 고른 아이디가 쌓인다. `already` 에 든 사람은 고르개에 「이미 초대됨」으로
   서고 고를 수 없다 — 목록에서 아예 빼면 "왜 이 사람이 안 보이지" 가 되고, 그냥 두면
   눌렀는데 아무 일도 안 일어난다. */
function friendPicker(box, { all, already = [], out, onChange }) {
  let query = "";
  const done = new Set(already);

  /* 찾기 칸은 **한 번만 그리고 그대로 둔다** — 글자마다 다시 그리면 한글처럼 모아 쓰는
     글자가 치는 도중에 깨진다. 갈아 끼우는 것은 아래 목록뿐이다. */
  const paintList = () => {
    const q = query.trim().toLowerCase();
    const left = all.filter(f => !out.includes(f.id))
      .filter(f => !q || f.displayName.toLowerCase().includes(q));
    const got = out.map(id => all.find(f => f.id === id)).filter(Boolean);
    const none = left.length ? (q ? left[0].displayName : "친구 고르기…")
      : q ? "찾는 이름이 없습니다" : "모두 골랐습니다";
    box.querySelector("[data-pk-body]").innerHTML = `
      <select data-pk-add aria-label="친구 고르기">
        <option value="">${esc(none)}</option>
        ${left.map(f => `<option value="${esc(f.id)}"${done.has(f.id) ? " disabled" : ""}>${
          f.starred ? icon("star", "on") + " " : ""}${esc(f.displayName)}${done.has(f.id) ? " — 이미 초대됨" : ""}</option>`).join("")}
      </select>
      ${got.length ? `<div class="pickers" style="margin-top:10px">${got.map(f =>
          `<button class="pick on" data-pk-off="${esc(f.id)}" title="빼기"
            >${esc(f.displayName)} <i>${icon("x")}</i></button>`).join("")}</div>` : ""}`;
    onChange?.();
  };

  box.innerHTML = `${all.length > 8 ? searchHtml("이름으로 좁히기", "", "margin-bottom:8px") : ""}
    <div data-pk-body></div>`;
  paintList();

  box.addEventListener("input", e => {
    if (!e.target.closest(".arch-q")) return;
    query = e.target.value;
    paintList();                            // 치던 칸은 그대로 둔다
  });
  box.addEventListener("change", e => {
    const sel = e.target.closest("[data-pk-add]"); if (!sel?.value) return;
    if (!done.has(sel.value)) out.push(sel.value);
    const qEl = box.querySelector(".arch-q");
    if (qEl) qEl.value = "";                // 담았으면 다음 사람을 찾을 차례다
    query = "";
    paintList();
  });
  box.addEventListener("click", e => {
    const b = e.target.closest("[data-pk-off]"); if (!b) return;
    const i = out.indexOf(b.dataset.pkOff);
    if (i >= 0) out.splice(i, 1);
    paintList();
  });
  return paintList;
}

/* 꾹 눌러 고르기. 친구 목록·폴더 목록·작품 격자가 같은 손짓을 쓰므로 한 자리에서 만든다.

   **끄는 손짓과 갈라야 한다** — 목록을 굴리려고 짚은 것도 처음에는 꾹 누르는 것과 똑같이
   생겼다. 8px 만 움직여도 손을 뗀 것으로 친다.

   `held` 를 **다음 pointerdown 에서 되돌리는 것**이 이 물건의 핵심이다. 꾹 누른 뒤 따라오는
   click 을 삼키려고 표를 세워 두는데, 꾹 누르는 사이에 목록을 다시 그리면 짚고 있던 마디가
   떨어져 나가 **그 click 이 아예 안 온다**. 그러면 표가 선 채로 남아 다음 톡을 대신 삼켰고,
   고르기에 들어간 직후 한 번은 아무 일도 안 일어났다. 손짓이 새로 시작할 때 지우면
   그 자리가 없어진다. */
function holdToPick(root, sel, onHold, opts = {}) {
  const ms = opts.ms ?? 450;
  let timer = null, from = null, held = false;
  const drop = () => { clearTimeout(timer); timer = null; };
  root.addEventListener("pointerdown", e => {
    held = false;                       // 지난번 꾹 누르기의 뒷정리 — click 이 안 왔을 수 있다
    const row = e.target.closest(sel); if (!row) return;
    from = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      timer = null; held = true;
      onHold(row);
      // 손끝에 걸리는 것이 있어야 "고르기로 들어왔다" 가 읽힌다. 없는 기기면 그냥 넘어간다.
      try { navigator.vibrate?.(12); } catch { }
    }, ms);
  });
  root.addEventListener("pointermove", e => {
    if (!timer || !from) return;
    if (Math.abs(e.clientX - from.x) > 8 || Math.abs(e.clientY - from.y) > 8) drop();
  });
  root.addEventListener("pointerup", drop);
  root.addEventListener("pointercancel", drop);
  /* 같은 마디에 걸린 다른 손잡이까지 막아야 하므로 stopImmediatePropagation 이다 —
     그냥 stopPropagation 은 같은 마디의 나머지 손잡이를 못 막는다. */
  root.addEventListener("click", e => {
    if (!held) return;
    held = false;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
}

/** 하나만 고르는 목록. 여는 방식 · 공개 대상 · 퍼가기 허용이 같은 모양을 쓴다.

    cols 를 주면 **가로로** 늘어놓는다. 그때는 설명을 버튼 안에 넣지 않는다 — 좁아서
    글자가 뭉개지고, 고르기 전에 셋을 다 읽을 이유도 없다. 대신 **고른 것의 설명만**
    아래에 작게 적는다(퍼가기 허용 태그와 같은 방식). */
const optsHtml = (list, current, key, cols = 0) => {
  const row = cols > 0;
  const now = list.find(([v]) => v === current);
  const style = row ? ' style="--opt-cols:' + cols + '"' : "";
  return `<div class="opts${row ? " row" : ""}" data-opts="${key}"${style}>
    ${list.map(([v, t, d]) => `<button class="opt" data-o="${v}" aria-pressed="${current === v}"${row ? ' title="' + esc(d) + '"' : ""}>
      <span class="mark"></span><span class="ot"><b>${t}</b>${row ? "" : `<span>${d}</span>`}</span></button>`).join("")}
  </div>` + (row
    ? `<div class="opt-why" data-opt-why="${key}">${esc(now?.[2] ?? "")}</div>`
    : "");
};

/** 태그 한 줄로 고르는 목록 — 딸려 붙는 자리에 쓴다(공개 범위처럼).
    고른 것의 설명만 아래에 작게 적는 것은 위(optsHtml)와 같다. */
const tagOptsHtml = (list, current, key) => {
  const now = list.find(([v]) => v === current);
  return `<div class="pickers tag-opts" data-opts="${key}">${list.map(([v, t]) =>
    `<button type="button" class="pick" data-o="${v}" aria-pressed="${current === v}"
      >${t}</button>`).join("")}</div>
    <div class="opt-why" data-opt-why="${key}">${esc(now?.[2] ?? "")}</div>`;
};

/** 고른 것을 눈에 보이게 하고 값을 넘겨준다 */
function wireOpts(root, key, onPick, list) {
  const box = root.querySelector(`[data-opts="${key}"]`); if (!box) return;
  /* 가로로 놓았으면 설명이 아래 한 줄에만 있다 — 고른 것이 바뀌면 그 줄도 갈아 끼운다. */
  const why = root.querySelector(`[data-opt-why="${key}"]`);
  if (why && list) box.addEventListener("click", e => {
    const b = e.target.closest("[data-o]"); if (!b) return;
    why.textContent = list.find(([v]) => v === b.dataset.o)?.[2] ?? "";
  });
  box.addEventListener("click", e => {
    const b = e.target.closest("[data-o]"); if (!b) return;
    for (const x of box.querySelectorAll("[data-o]")) x.setAttribute("aria-pressed", x === b);
    onPick(b.dataset.o);
  });
}

/** 시트 맨 아래의 실행 버튼.

    같은 일을 하는 버튼이 머리줄에도 있다(headHtml). 둘 중 **하나만** 보여야 하는데,
    가르는 기준은 화면 너비가 아니라 마우스가 있느냐다 (styles.css 의 .wide-only).
    손가락이면 머리줄 오른쪽 끝, 마우스면 여기. 한때 손가락에서도 이 버튼이 같이 보여
    "담기" 가 한 화면에 둘씩 있었다.

    숨어 있어도 DOM 에는 남는다 — 머리줄의 저장은 이 버튼을 눌러 주는 방식이라
    (wireHead) 지워 버리면 손가락으로는 담을 수 없게 된다. */
const actionRow = (id, label) =>
  `<div class="link-row wide-only sep"><button class="btn primary" id="${id}">${label}</button></div>`;

/* ── 일정·폴더 편집기 (등록 시트와 작품 시트가 공유) ───────── */
function schedSummary(s) {
  const warn = t => `<span style="color:var(--warn);font-weight:600">${t}</span>`
    + ` — 고르기 전까지는 &ldquo;일정 없음&rdquo;에 머뭅니다.`;
  const hi = t => `<b style="color:var(--accent-ink)">${t}</b>`;

  if (s.mode === "weekly" || s.mode === "biweekly") {
    if (!s.days.length) return warn("요일을 하나 이상 골라주세요");
    const d = hi(`${[...s.days].sort().map(i => DOW[i]).join("·")}요일`);
    if (s.mode === "weekly") return `매주 ${d}에 캘린더에 놓입니다.`;
    const nextWk = s.next && mondayOf(s.next) > mondayOf(Date.now());
    return `${hi(nextWk ? "다음 주" : "이번 주")}부터 격주로 ${d}에 놓입니다.`;
  }
  if (s.mode === "monthly") {
    if (!s.days.length) return warn("날짜를 하나 이상 골라주세요");
    return `매월 ${hi([...s.days].sort((a, b) => a - b).join("·") + "일")}에 놓입니다.`
      + (s.days.some(d => d > 28) ? " 그 날이 없는 달은 말일에 놓입니다." : "");
  }
  if (s.mode === "monthly-dow") {
    if (!s.days.length) return warn("주차와 요일을 골라주세요");
    return `매월 ${hi([...s.days].sort((a, b) => a - b).map(nthLabel).join(", "))}에 놓입니다.`;
  }
  return "";
}

/** 색 고르개 한 벌. 작품 색과 도메인 색이 같은 물건을 쓴다. */
function colorPickerHtml(value, fallback, label, autoText = "자동") {
  const cur = value ?? fallback ?? "#888888";
  return `<div class="field" data-color>
    <label>${label}</label>
    <div class="cpick${value ? "" : " auto"}">
      <label class="cp-open" data-chip style="background:${cur}" title="색 고르기">
        <input type="color" data-native value="${cur}" aria-label="색 고르기"></label>
      <input class="cp-hex" data-hex value="${esc(value ?? "")}"
             placeholder="${esc(fallback ?? "#888888")}" maxlength="7" spellcheck="false"
             aria-label="색 값">
      <button class="btn" type="button" data-c="" aria-pressed="${!value}">${autoText}</button>
    </div></div>`;
}

/** 달력의 어느 날에 놓이는 주기인가 — 그럴 때만 색을 고르는 뜻이 있다 */
const placedOnDays = m => ["weekly", "biweekly", "monthly", "monthly-dow", "dated"].includes(m);

function schedHtml(s, note, color) {
  const nextVal = s.next
    ? new Date(s.next - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10) : "";
  /* 색과 일정은 **한 단락**이다 — 둘 다 달력에서 이 작품이 어떻게 보이는지를 정한다.
     그래서 구분선은 둘을 감싼 바깥에 한 번만 긋는다. */
  return `<div class="sep">${color && placedOnDays(s.mode)
      ? colorPickerHtml(color.value, color.fallback,
          `캘린더 점 색 <span style="text-transform:none;letter-spacing:0">— 달력에서 이 작품을 나타내는 색</span>`)
      : ""}
    <div class="field" data-sched>
    <label>연재 일정${note ? ` <span style="text-transform:none;letter-spacing:0">— ${note}</span>` : ""}</label>
    <div class="pickers" style="margin-bottom:8px">
      ${SCHED_MODES.map(([m, l]) =>
    `<button class="pick" data-mode="${m}" aria-pressed="${
      m === "monthly" ? isMonthly(s.mode) : s.mode === m}">${l}</button>`).join("")}
    </div>
    ${s.mode === "weekly" || s.mode === "biweekly"
      ? `${s.mode === "biweekly"
          ? `<div class="anchor"><span>기준 주</span>
              ${[[0, "이번 주"], [1, "다음 주"]].map(([n, l]) =>
                `<button data-anchor="${n}" aria-pressed="${
                  (mondayOf(s.next ?? Date.now()) > mondayOf(Date.now())) === !!n}">${l}</button>`).join("")}
             </div>` : ""}
         <div class="dows">${DOW.map((d, i) =>
          `<button data-dow="${i}" aria-pressed="${s.days.includes(i)}">${d}</button>`).join("")}</div>
         <div class="rest" data-sched-sum style="padding:7px 2px 0">${schedSummary(s)}</div>`
      : isMonthly(s.mode)
        ? `<div class="anchor"><span>어떻게 정하나요</span>
             ${[["monthly", "날짜로"], ["monthly-dow", "요일로"]].map(([m, l]) =>
               `<button data-mode="${m}" aria-pressed="${s.mode === m}">${l}</button>`).join("")}
           </div>
           ${s.mode === "monthly"
             ? `<div class="doms">${Array.from({ length: 31 }, (_, i) =>
                 `<button data-dom="${i + 1}" aria-pressed="${s.days.includes(i + 1)}">${i + 1}</button>`).join("")}</div>`
             : `<div class="ndows">
                 <span></span>${DOW.map(d => `<span>${d}</span>`).join("")}
                 ${NTH.map(([n, label]) => `<span class="nl">${label}</span>${
                   DOW.map((_, d) => { const v = packNth(n, d);
                     return `<button data-ndow="${v}" aria-pressed="${s.days.includes(v)}"
                       aria-label="${label} ${DOW[d]}요일"></button>`; }).join("")}`).join("")}
                </div>`}
           <div class="rest" data-sched-sum style="padding:7px 2px 0">${schedSummary(s)}</div>`
      : s.mode === "dated"
        ? `<input type="date" data-next value="${nextVal}">`
        : `<div class="rest" style="padding:2px">${SCHED_HINT[s.mode] ?? ""}</div>`}
  </div></div>`;
}

/* 색 고르개 배선. 사각형을 집으면 채도·명도, 슬라이더가 색상, 값 칸은 직접 입력이다.
   셋 중 어느 쪽을 만져도 나머지가 따라온다. */
function wireColorPicker(root, draft, fallback, opts = {}) {
  const { nullable = true, onChange } = opts;
  const box = root.querySelector("[data-color]"); if (!box) return;
  const native = box.querySelector("[data-native]"), hex = box.querySelector("[data-hex]");
  const chip = box.querySelector("[data-chip]"), auto = box.querySelector("button[data-c]");
  const pick = box.querySelector(".cpick");

  const paint = (writeHex = true) => {
    const shown = draft.color ?? fallback;
    chip.style.background = shown;
    native.value = shown;
    if (writeHex) hex.value = draft.color ?? "";
    pick.classList.toggle("auto", !draft.color);
    auto.setAttribute("aria-pressed", !draft.color);
    onChange?.();
  };

  // 운영체제 색 고르기 창은 확인을 눌러야 change를 준다 — 고르는 즉시 오는 input을 쓴다
  native.addEventListener("input", () => { draft.color = native.value.toLowerCase(); paint(); });

  hex.addEventListener("input", () => {
    const v = hex.value.trim();
    if (!v) { draft.color = nullable ? null : fallback; paint(false); return; }
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) return;   // 아직 치는 중
    draft.color = v.toLowerCase();
    paint(false);
  });

  auto.addEventListener("click", () => {
    // 도메인 색처럼 비울 수 없는 자리에서는 기본값으로 되돌린다
    draft.color = nullable ? null : fallback;
    paint();
  });

  paint();
}

function wireSched(root, s, onChange) {
  const box = root.querySelector("[data-sched]"); if (!box) return;
  box.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;

    if (b.dataset.mode) {
      const prev = s.mode, next = b.dataset.mode;
      if (prev !== next) {
        if (daysKind(prev) !== daysKind(next)) s.days = [];
        // next 칸도 뜻이 겹친다 — 격주는 기준 주, 날짜 지정은 그 날짜다
        if (next === "biweekly") s.next = mondayOf(Date.now());
        else if (prev === "biweekly") s.next = null;
      }
      s.mode = next;
      onChange(true);
      return;
    }

    const sum = () => {
      const el = box.querySelector("[data-sched-sum]");
      if (el) el.innerHTML = schedSummary(s);
    };

    if (b.dataset.anchor !== undefined) {
      s.next = mondayOf(Date.now()) + (+b.dataset.anchor) * 7 * 864e5;
      box.querySelectorAll("[data-anchor]").forEach(x =>
        x.setAttribute("aria-pressed", x === b));
      sum();
      onChange(false);
      return;
    }

    const num = b.dataset.dow ?? b.dataset.dom ?? b.dataset.ndow;
    if (num !== undefined) {
      const d = +num, i = s.days.indexOf(d);
      if (i < 0) s.days.push(d); else s.days.splice(i, 1);
      b.setAttribute("aria-pressed", i < 0);
      sum();
      onChange(false);
    }
  });
  const dateEl = box.querySelector("[data-next]");
  if (dateEl) dateEl.addEventListener("change", () => {
    s.next = dateEl.value ? new Date(dateEl.value + "T00:00").getTime() : null;
    onChange(false);
  });
}

function pickerHtml(selected) {
  return `<div class="field sep"><label>폴더</label>
    <div class="pickers" data-picker>
      ${/* 비추기만 하는 폴더는 남의 것이라 넣을 수 없다. **함께 고치는** 폴더는 넣을 수
           있으므로 함께 올린다 — 그때 이어지는 곳은 원본 폴더다 (서버의 setWorkFolders). */""}
      ${folders.filter(f => !f.mirror || f.canEdit).map(f =>
        `<button class="pick" data-fid="${f.mirror ? f.mirror.folder : f.id}"
          aria-pressed="${selected.includes(f.mirror ? f.mirror.folder : f.id)}"
          >${f.emoji} ${esc(f.name)}${f.mirror ? " (함께)" : ""}</button>`).join("")}
      <button class="pick add" data-picker-new>${icon("plus")} 새 폴더</button>
    </div></div>`;
}

function wirePicker(root, selected, onChange, reopen) {
  const box = root.querySelector("[data-picker]"); if (!box) return;
  box.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.pickerNew !== undefined) {
      openFolderForm(null, f => { if (f) selected.push(f.id); reopen(); });
      return;
    }
    const i = selected.indexOf(b.dataset.fid);
    if (i < 0) selected.push(b.dataset.fid); else selected.splice(i, 1);
    b.setAttribute("aria-pressed", i < 0);
    onChange();
  });
}

/* ── 폴더 ────────────────────────────────────────────────── */
const EMOJIS = ["📁", "📌", "⚔️", "💕", "🍿", "📖", "🎬", "🔥", "🌙", "😂", "👻", "🏆"];

/** 이모지 한 글자만 남긴다. 글자나 숫자가 섞이면 폴더 마크가 아니라 이름처럼 보인다.
    사람 눈에 한 글자로 보이는 단위(👨‍👩‍👧 처럼 여러 부호가 이어진 것)를 통째로 다룬다. */
function emojiOnly(v) {
  const parts = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(v)].map(x => x.segment)
    : [...v];
  return parts.find(g => /\p{Extended_Pictographic}/u.test(g)) ?? "";
}

/* 폴더를 여러 개 골라 한 번에 지운다. null 이면 평소 화면, Set 이면 고르는 중이다.
   화면 상태라 폴더 목록 밖에 둔다 — 지운 뒤 다시 그려도 고르던 중인지가 유지된다.

   보관함의 여러 개 고르기와 같은 모양(네모칸 · 고른 수를 띄우는 줄 · 전체 선택)을 쓴다.
   같은 일을 두 곳에서 다르게 보이게 할 이유가 없다. */
let folderSel = null;

/** 폴더 목록 머리줄 — 평소엔 "선택", 고르는 중이면 몇 개인지와 처리 버튼 */
/* 폴더 목록에 세 갈래가 한 줄로 섞여 선다 — 내 것, 함께 쓰는 것, 비추는 것.
   딱지(.mtag)로 갈리기는 하지만 스무 개가 넘어가면 딱지를 하나씩 읽어야 하고,
   "내가 만든 것만 보자" 가 안 된다.

   갈래를 가르는 잣대는 **폴더 줄에 이미 붙어 있는 딱지와 같다** — 화면에 보이는 말과
   거르는 말이 다르면 골랐는데 딴 것이 나온다.
     · 함께 쓰는 것 — 내가 연 것(canEdit(take))과 불려 간 것(canEdit) 둘 다
     · 비추는 것    — 남의 폴더를 비추는 껍데기 중 함께 쓰지 않는 것
     · 일반         — 그 밖의 내 폴더 */
const folderKind = f =>
  canEdit(f.take) || f.canEdit ? "team" : f.mirror ? "mirror" : "plain";
const FOLDER_KINDS = [["all", "전체"], ["plain", "일반"], ["team", "공유"], ["mirror", "미러링"]];
let fkind = "all";                       // 화면 상태라 시트 밖에 둔다 — 다시 그려도 남는다
/* 별 켠 폴더가 맨 위로 온다. 친구 목록은 첫소리 차례라 그러지 않았는데(ㄱㄴㄷ 띠를
   짚어 뛰려면 차례가 그 띠와 같아야 한다), 폴더는 짚을 띠가 없어 자주 여는 것을 위로
   올리는 편이 낫다.

   **별 켠 것끼리는 켠 차례**다. 만든 차례로 두면 맨 위 무리가 목록 아래쪽 차례를 그대로
   베껴 와, 방금 켠 폴더가 엉뚱한 데 끼어 있다 — 켠 사람은 맨 끝에서 찾게 된다.
   별을 안 켠 것들끼리는 만든 차례(ord)를 지킨다. */
const kindShown = () => folders
  .filter(f => fkind === "all" || folderKind(f) === fkind)
  .slice().sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0)
    || (a.starred ? (a.starredAt || 0) - (b.starredAt || 0) : 0));

/** 갈래 고르개. **두 갈래 넘게 있을 때만** 나온다 — 고를 것이 하나뿐인 고르개는 자리만 먹는다. */
function kindChips() {
  const have = new Set(folders.map(folderKind));
  if (folderSel || have.size < 2) return "";
  const n = k => (k === "all" ? folders.length : folders.filter(f => folderKind(f) === k).length);
  return `<div class="chips">${FOLDER_KINDS
    .filter(([k]) => k === "all" || have.has(k))
    .map(([k, t]) => `<button class="chip" data-fkind="${k}" aria-pressed="${fkind === k}"
      >${t} ${n(k)}</button>`).join("")}</div>`;
}

function folderBar() {
  if (!folders.length) return "";
  if (!folderSel) {
    /* 갈래를 좁혀 놓았으면 **보이는 수**를 적는다 — 세 줄만 서 있는데
       "폴더 15개" 라고 적혀 있으면 나머지가 어디 갔나 찾게 된다. */
    const vis = kindShown().length;
    return `<div class="fbar"><span>폴더 ${
      fkind === "all" ? `${folders.length}개` : `${vis}개 · 전체 ${folders.length}개`}</span>
      <span class="fbar-btns">
        <button class="mini-btn" data-fav-list>${icon("star")} 즐겨찾기</button>
        <button class="mini-btn" data-fsel>선택</button>
      </span></div>`;
  }

  // 갈래로 좁혀 놓았으면 **보이는 것만** 집는다 — 안 보이는 폴더가 함께 지워지면 안 된다
  const all = kindShown().every(f => folderSel.has(f.id));
  return `<div class="bulk">
    <b>${folderSel.size}개 선택</b>
    <button class="mini-btn" data-fsel-all>${all ? "전체 해제" : "전체 선택"}</button>
    <span class="bulk-act">
      <button class="mini-btn danger" data-fsel-del${folderSel.size ? "" : " disabled"}>삭제</button>
      <button class="mini-btn" data-fsel-off>완료</button>
    </span></div>`;
}

/** 고른 폴더를 한꺼번에 지운다 — 묶음만 사라지고 작품은 목록에 남는다 */
const deleteFolders = guard(async () => {
  const ids = [...folderSel];
  if (!ids.length) return;
  const picked = folders.filter(f => ids.includes(f.id));
  const names = picked.map(f => f.name);
  const mirrors = picked.filter(f => f.mirror).length;
  const yes = await askSure({
    title: `폴더 ${ids.length}개를 삭제할까요?`,
    body: `${esc(names.slice(0, 3).join(", "))}${names.length > 3
      ? ` 외 ${names.length - 3}개` : ""}. 묶음만 사라지고 내 작품은 목록에 남습니다.${
      mirrors ? ` 비추는 폴더 ${mirrors}개는 미러링이 끊기고, 그 안의 작품은 원래 내 것이 아니라 함께 사라집니다.` : ""}`,
  });
  if (!yes) return;
  for (const id of ids) await api("DELETE", `/api/folders/${id}`);
  folderSel = null;
  await reload(); render();
  toast(`폴더 ${ids.length}개를 삭제했습니다`);
});

/** 즐겨찾기에 넣은 폴더만 모아 보는 창.

    목록에서도 별 켠 것이 맨 위에 서지만, 폴더가 스물을 넘어가면 「맨 위」가 곧 「한눈에」
    는 아니다 — 갈래로 좁혀 놓았으면 별 켠 것이 걸러져 아예 안 보이기도 한다. 여기서는
    갈래를 보지 않고 별 켠 것만 세운다.

    이 창에서도 별을 끌 수 있다. 끄면 그 줄이 이 창에서 사라지는 것이 당연한 결과라,
    「어디서 켰는지」 를 기억하지 않아도 된다. */
function openFavFolders() {
  const draw = () => {
    /* 폴더 목록은 만든 차례인데, 여기서는 **별을 켠 차례**로 세운다. 즐겨찾기는 내가
       하나씩 골라 쌓은 것이라, 쌓은 차례가 곧 내가 기억하는 차례다. */
    const list = folders.filter(f => f.starred)
      .slice().sort((a, b) => (a.starredAt || 0) - (b.starredAt || 0));
    const favIdx = folderIndex();
    openSheet(`
      ${headHtml("즐겨찾기", { back: false, actions: false, sub: `${list.length}개` })}
      ${list.length
        ? `<div class="folders">${list
            .map(f => folderRow(f.id, f.emoji, f.name, f, favIdx)).join("")}</div>`
        : `<div class="empty">즐겨찾기에 넣은 폴더가 없습니다.<br>폴더 목록에서 별을 눌러 보세요.</div>`}`);

    sheet.addEventListener("click", e => {
      const st = e.target.closest("[data-fstar]");
      if (st) {
        const f = folders.find(x => x.id === st.dataset.fstar);
        if (!f) return;
        flipStar(f);
        draw();                                  // 끈 줄은 이 창에서 빠진다
        render();                                // 뒤에 선 목록의 차례도 함께 바뀐다
        return api("PUT", `/api/folders/${f.id}/star`, { starred: f.starred })
          .catch(err => { flipStar(f); draw(); render(); toast(err.message); });
      }
      const fe = e.target.closest("[data-folder-edit]");
      if (fe) return openFolderForm(folders.find(x => x.id === fe.dataset.folderEdit),
        () => { closeSheet(); render(); });
      const fo = e.target.closest("[data-folder]");
      if (fo) { closeSheet(); openFolderSheet(fo.dataset.folder); }
    });
  };
  draw();
}

/** 비추는 폴더 — 내 것이 아니라 고칠 것이 없다. 끊는 길만 둔다. */
function openMirrorInfo(f, after) {
  const n = worksIn(f.id).length;
  openSheet(`
    ${headHtml(`${f.emoji} ${esc(f.name)}`, { back: false, actions: false,
      sub: `${esc(f.mirrorOf)}님의 폴더${f.canEdit ? "를 함께 쓰는 중" : "를 미러링 중"}` })}
    <div class="rest" style="text-align:left;padding:2px 2px 10px">${f.broken
      ? `지금은 볼 수 없습니다 — ${esc(f.broken)}. 폴더는 남아 있지만 비어 있습니다.`
      : f.canEdit
        ? `지금 ${n}편이 담겨 있습니다. <b>내 작품을 넣고 뺄 수 있고</b>, 넣은 것은
           ${esc(f.mirrorOf)}님에게도 보입니다. 폴더 이름과 공개 설정은 ${esc(f.mirrorOf)}님 것이고,
           남이 넣은 작품은 그 사람만 고칩니다 — 내 캘린더에도 올라오지 않습니다.`
        : `${esc(f.mirrorOf)}님의 폴더에서 지금 ${n}편이 비쳐 오고 있습니다. 그쪽에서 넣거나 빼면 여기도 바뀝니다.
           이름·아이콘·공개 설정은 ${esc(f.mirrorOf)}님 것이라 내가 고칠 수 없고,
           안의 작품도 마찬가지입니다.`}</div>
    <button class="btn" style="width:100%" id="fdel">${f.canEdit ? "함께 쓰기 그만두기" : "미러링 끊기"}</button>
    <div class="note">그만두어도 ${esc(f.mirrorOf)}님 폴더는 그대로입니다. 내가 넣어 둔 작품도
      내 목록에 그대로 남고, 이 묶음에서만 빠집니다.</div>`);

  sheet.querySelector("#fdel").onclick = guard(async () => {
    const yes = await askSure({
      title: "미러링을 끊을까요?",
      body: `${esc(f.name)} 이(가) 내 폴더 탭에서 사라집니다. ${esc(f.mirrorOf)}님 것은 그대로입니다.`,
      ok: "끊기", back: () => openMirrorInfo(f, after),
    });
    if (!yes) return;
    await api("DELETE", `/api/folders/${f.id}`);
    await reload(); render(); after(null);
  });
}

function openFolderForm(existing, after) {
  // 비추는 폴더는 남의 것이다 — 고치는 창을 열 이유가 없다
  if (existing?.mirror) return openMirrorInfo(existing, after);
  let emoji = existing ? existing.emoji : "📁";
  // 견본에 없는 아이콘을 쓰고 있었다면 직접 입력칸을 열어 둔 채로 시작한다
  const own = !EMOJIS.includes(emoji);
  // 지금 이 폴더를 누구에게 열어 두었는가. 새 폴더는 늘 나만 본다.
  const share = { mode: existing?.share?.mode ?? "none", with: [...(existing?.share?.with ?? [])] };
  /* **켜고 끄는 셋.** 무엇을 열어 둘지 먼저 정하고, 그다음에 누구에게 열지 정한다 —
     「이 폴더로 무엇을 할 수 있나」가 「누구에게」보다 앞선 물음이다.
     기본은 클로닝 하나. 미러링은 "내가 고르는 걸 계속 보라" 는 뜻이라 직접 켜야 열린다. */
  const flags = new Set(String(existing?.take ?? "copy").split(",").filter(Boolean));

  /** 켜고 끄는 단추 넷 — 비공개는 고르는 것이 아니라 **셋이 다 꺼진 결과**다.

      이 창에서 **먼저 정하는 것**이라 큰 칸으로 세운다. 범위(누구에게)는 그다음이라
      작은 태그로 딸려 붙는다 — 앞선 물음이 눈에 먼저 들어와야 차례가 읽힌다.

      켜고 끄는 것이라 표시가 동그라미가 아니라 **체크**다. 동그라미는 「셋 중 하나」로
      읽히는데 여기서는 여럿을 켤 수 있다. */
  const takeHtml = () => {
    const off = flags.size === 0;
    const card = (v, t, on) => `<button type="button" class="opt${on ? " on" : ""}"
      ${v ? `data-take="${v}"` : "data-take-off"} aria-pressed="${on}">
      <span class="mark tick"></span><span class="ot"><b>${t}</b></span></button>`;
    return `<div class="opts row take-flags" style="--opt-cols:4">
      ${card("", "비공개", off)}
      ${TAKE_FLAGS.map(([v, t]) => card(v, t, flags.has(v))).join("")}
    </div>
    <div class="opt-why">${off
      ? "아무에게도 보이지 않습니다."
      : TAKE_FLAGS.filter(([v]) => flags.has(v)).map(([, , d]) => d).join(" ")}</div>`;
  };
  openSheet(`
    ${headHtml(existing ? "폴더 편집" : "새 폴더", { back: false,
      save: existing ? "저장" : "만들기" })}
    <div class="field"><label>아이콘</label>
      <div class="emoji-row" id="emo">${EMOJIS.map(e =>
    `<button data-e="${e}" aria-pressed="${e === emoji}">${e}</button>`).join("")}
        <button class="emo-more" data-emo-more aria-pressed="${own}"
          title="직접 넣기" aria-label="아이콘 직접 넣기">${icon("plus")}</button>
      </div>
      <div class="emoji-own"${own ? "" : " hidden"}>
        <input id="emo-in" value="${own ? esc(emoji) : ""}" maxlength="8" spellcheck="false"
               placeholder="🙂" aria-label="아이콘 직접 입력">
      </div></div>
    <div class="field"><label for="fname">이름</label>
      <input id="fname" value="${esc(existing?.name ?? "")}" placeholder="예: 주말에 몰아볼 것" maxlength="24"></div>
    ${/* 여기서부터 **남에게 보이는 이야기**다 — 위(아이콘·이름)는 내 폴더를 꾸미는
         일이고 아래는 남과 나누는 일이라, 선 하나로 갈라 둔다. */""}
    ${guestMode() ? `<div class="field sep"><label>친구에게 공개</label>
      <div class="rest" style="text-align:left;padding:2px">
        둘러보기로는 폴더를 공개할 수 없습니다. 로그인하면 쓸 수 있어요.</div></div>` : ""}
    ${!guestMode() ? `<div class="field sep"><label>공개 설정</label>
      ${/* **무엇을 열어 둘지가 먼저다.** 「누구에게」는 그다음 물음이고, 아무것도
           안 열어 두었으면 물을 것도 없다. 그래서 셋이 다 꺼져 있으면 범위 칸이 사라진다. */""}
      <div data-take-box>${takeHtml()}</div>
      <div data-scope${flags.size ? "" : " hidden"}>
      ${/* 범위는 **그다음 물음**이라 작은 태그로 딸려 붙는다. 위에서 무엇을 열지
           정하고 나면, 여기서는 그 대상을 좁히기만 하면 된다. */""}
      <div class="scope-lab">공개 범위</div>
      ${tagOptsHtml(SHARE_MODES, share.mode, "share")}
      <div data-share-who${share.mode === "some" ? "" : " hidden"}>
        <div class="rest" style="text-align:left;padding:8px 2px 0">친구를 불러오는 중…</div>
      </div>
      </div>
    </div>` : ""}
    ${existing ? `<div class="link-row"><button class="btn bad" id="fdel">폴더 삭제</button></div>` : ""}
    <div class="link-row wide-only">
      <button class="btn" data-cancel>취소</button>
      <button class="btn primary" data-done>${existing ? "저장" : "만들기"}</button>
    </div>
  `);
  const nameEl = sheet.querySelector("#fname");
  const emoIn = sheet.querySelector("#emo-in");
  const markEmoji = () => sheet.querySelectorAll("#emo button")
    .forEach(x => x.setAttribute("aria-pressed", x.dataset.e === emoji));

  const ownBox = sheet.querySelector(".emoji-own");
  const moreBtn = sheet.querySelector("[data-emo-more]");

  sheet.querySelector("#emo").addEventListener("click", e => {
    if (e.target.closest("[data-emo-more]")) {     // 직접 넣는 칸을 여닫는다
      const show = ownBox.hidden;
      ownBox.hidden = !show;
      moreBtn.setAttribute("aria-pressed", show);
      if (show) emoIn.focus();
      return;
    }
    const b = e.target.closest("button[data-e]"); if (!b) return;
    emoji = b.dataset.e;
    /* 견본을 골랐으면 직접 넣던 칸은 닫는다 — 값을 비워 두고 칸만 열어 두면
       무엇이 골라져 있는지 두 곳을 견줘 봐야 한다. */
    emoIn.value = "";
    ownBox.hidden = true;
    moreBtn.setAttribute("aria-pressed", false);
    markEmoji();
  });

  // 이모지만 받는다. 비우면 마지막으로 고른 견본이나 기본 아이콘으로 돌아간다.
  emoIn.addEventListener("input", () => {
    emoIn.value = emojiOnly(emoIn.value);
    emoji = emoIn.value || (EMOJIS.includes(emoji) ? emoji : "📁");
    markEmoji();
  });
  const whoBox = sheet.querySelector("[data-share-who]");
  if (whoBox) {
    let drawn = false;

    /* 친구를 **고르개(select)로 하나씩** 담는다. 한때 모든 친구를 이름 칩으로 깔아 두고
       눌러서 켜고 껐는데, 수십 명이 되면 그것만으로 화면이 가득 차서 정작 아래에 있는
       퍼가기 설정이 안 보였다. 지금은 담은 사람만 보이므로 목록 길이가 고른 수만큼이다.

       고르개·찾기 칸·이름표는 「공유자」 창의 「더 부르기」와 **같은 물건**이라 한 자리에서
       만든다(friendPicker). 한때 두 벌이 따로 있었고, 한쪽만 고친 탓에 같은 창의 같은
       칸이 서로 다르게 굴었다. */
    const drawWho = async () => {
      if (drawn) return;
      drawn = true;
      await loadFriends();
      if (!friends.length) {
        whoBox.innerHTML = `<div class="rest" style="text-align:left;padding:2px">아직 친구가 없습니다.</div>`;
        return;
      }
      friendPicker(whoBox, { all: friends, out: share.with });
    };
    if (share.mode === "some") drawWho();

    const takeBox = sheet.querySelector("[data-take-box]");
    const scopeBox = sheet.querySelector("[data-scope]");
    const paintTake = () => {
      takeBox.innerHTML = takeHtml();
      /* 아무것도 안 열어 두었으면 「누구에게」를 물을 것이 없다. */
      scopeBox.hidden = flags.size === 0;
    };
    paintTake();

    wireOpts(sheet, "share", v => {
      share.mode = v;
      whoBox.hidden = v !== "some";
      if (v === "some") drawWho();
      /* 쉐어링은 **고른 친구에게만** 일 때만 켤 수 있다 — 초대를 보내려면 이름이 적힌
         명단이 있어야 하는데 「모든 친구에게」에는 그 명단이 없다. 범위를 넓히면
         쉐어링은 저절로 꺼진다. */
      if (v !== "some" && flags.has("edit")) { flags.delete("edit"); paintTake(); }
    }, SHARE_MODES);

    takeBox.addEventListener("click", e => {
      if (e.target.closest("[data-take-off]")) {      // 비공개 — 셋을 한꺼번에 끈다
        flags.clear(); share.mode = "none"; paintTake(); return;
      }
      const b = e.target.closest("[data-take]"); if (!b) return;
      const v = b.dataset.take;
      if (flags.has(v)) flags.delete(v);
      else {
        /* 비공개에서 처음 켜는 참이면 범위가 「none」이라 아무것도 골라져 있지 않다.
           고르라고 빈 채로 두면 안 고르고 저장하기 쉬우므로 **전체 공개**로 시작한다 —
           좁히는 것은 한 번 더 누르면 되고, 친구에게만 보이는 것이라 위험이 크지 않다. */
        if (share.mode === "none") {
          share.mode = "all";
          const opts = sheet.querySelector('[data-opts="share"]');
          opts?.querySelectorAll("[data-o]").forEach(x =>
            x.setAttribute("aria-pressed", String(x.dataset.o === "all")));
          const why = sheet.querySelector('[data-opt-why="share"]');
          if (why) why.textContent = SHARE_MODES.find(([m]) => m === "all")?.[2] ?? "";
        }
        /* 쉐어링을 켜면 범위가 「고른 친구에게만」이어야 한다 — 초대할 명단이 필요하다.
           나만 보기였다면 그리로 옮겨 주고, 고르개도 함께 켠다. */
        if (v === "edit" && share.mode !== "some") {
          share.mode = "some";
          const opts = sheet.querySelector('[data-opts="share"]');
          opts?.querySelectorAll("[data-o]").forEach(x =>
            x.setAttribute("aria-pressed", String(x.dataset.o === "some")));
          const why = sheet.querySelector('[data-opt-why="share"]');
          if (why) why.textContent = SHARE_MODES.find(([m]) => m === "some")?.[2] ?? "";
          whoBox.hidden = false; drawWho();
        }
        flags.add(v);
      }
      if (flags.size === 0) share.mode = "none";     // 손으로 마지막 하나를 꺼도 같다
      paintTake();
    });
  }
  /* 공개를 거두는 설정은 **남의 화면에서 무언가를 없앤다.** 저장하기 전에 한 번 묻는다 —
     이름을 고치러 들어왔다가 옆 칸을 잘못 건드려 남의 폴더를 비워 버리면 되돌릴 길이 없다. */
  const revoking = () => {
    if (!existing) return null;
    const was = existing.share;
    const wasTeam = canEdit(existing.take);
    const stillTeam = flags.has("edit") && share.mode === "some";
    /* 명단에서 떨어져 나가는 사람. **이름을 댈 수 있는 것은 「고른 친구에게만」끼리 견줄
       때뿐이다** — 「모든 친구에게」였다면 애초에 명단이 없어 누가 빠지는지 알 수 없다. */
    const gone = was.mode === "some" && share.mode === "some"
      ? was.with.filter(id => !share.with.includes(id)) : [];
    /* 볼 사람이 좁아지는가. 좁아지면 **비추던 사람이 떨어져 나갈 수 있다** —
       담아간 사람은 이미 제 것을 한 벌 갖고 있으므로 이 셈에 들지 않는다. */
    const narrowed = was.mode !== "none" &&
      (share.mode === "none" || (was.mode === "all" && share.mode !== "all") || gone.length > 0);
    const nameList = ids => ids.map(id => (friends ?? []).find(f => f.id === id)?.displayName)
      .filter(Boolean);
    if (wasTeam && !stillTeam) {
      const n = works.filter(w => w.mirror && w.folders.includes(existing.id)).length;
      return { title: "함께 쓰기를 그만둘까요?",
        body: `함께 쓰던 사람들이 이 폴더를 더 볼 수 없게 됩니다.${
          n ? ` 그 사람들이 넣어 둔 ${n}편도 이 폴더에서 빠집니다 — 작품은 각자 목록에 남습니다.` : ""}`,
        ok: "그만두기" };
    }
    if (wasTeam && gone.length) {
      const names = nameList(gone);
      return { title: `${gone.length}명을 명단에서 뺄까요?`,
        body: `${esc(names.join(", ") || "고른 사람")}${names.length ? "님" : ""}이 이 폴더를 더 볼 수 없게 되고,
          넣어 둔 작품도 이 폴더에서 빠집니다 — 작품은 그 사람 목록에 남습니다.`,
        ok: "빼기" };
    }
    /* 넓은 것부터 묻는다 — 공개를 아예 거두면 보던 사람도 비추던 사람도 한꺼번에 잃는다. */
    if (was.mode !== "none" && share.mode === "none") {
      return { title: "공개를 거둘까요?",
        body: "이 폴더를 보던 친구들이 더 볼 수 없게 됩니다. 비추고 있던 사람의 폴더도 비게 됩니다.",
        ok: "거두기" };
    }
    /* 비추던 사람도 마찬가지다. 몇 명이 비추고 있는지는 여기서 알 수 없으므로 세지 않는다 —
       "있을 수 있다" 는 것만 알려도 손이 멈춘다. */
    if (canMirror(existing.take) && !flags.has("mirror") && was.mode !== "none") {
      return { title: "미러링을 끊을까요?",
        body: `이 폴더를 비추고 있는 친구가 있다면 그 사람의 폴더가 비게 됩니다.
          폴더 줄은 남고 왜인지가 적힙니다.`,
        ok: "끊기" };
    }
    /* **미러링은 그대로인데 볼 사람이 줄어드는 경우.** 여기에 오래 구멍이 있었다 —
       「둘 다」나 「미러링만」으로 열어 둔 채 공개 대상만 좁히면, 퍼가기 칸은 손대지 않았으니
       아무 일도 없어 보이는데 명단에서 빠진 사람의 폴더는 그 자리에서 빈다.
       끊는 것은 퍼가기 설정만이 아니라 **볼 수 있느냐** 이기도 하다. */
    if (flags.has("mirror") && narrowed) {
      const names = nameList(gone);
      return gone.length
        ? { title: `${gone.length}명을 명단에서 뺄까요?`,
            body: `${esc(names.join(", ") || "고른 사람")}${names.length ? "님" : ""}이 이 폴더를
              더 볼 수 없게 됩니다. 이 폴더를 비추고 있었다면 그 폴더도 비게 됩니다.`,
            ok: "빼기" }
        : { title: "볼 사람을 좁힐까요?",
            body: `이제 고른 사람만 볼 수 있습니다. 명단에 없는 친구가 이 폴더를 비추고
              있었다면 그 폴더가 비게 됩니다.`,
            ok: "좁히기" };
    }
    return null;
  };

  wireHead({
    save: guard(async () => {
      const name = nameEl.value.trim();
      if (!name) { nameEl.focus(); return; }
      const warn = revoking();
      if (warn && !await askSure({ ...warn, back: () => openFolderForm(existing, after) })) return;
      let folder;
      if (existing) {
        await api("PATCH", `/api/folders/${existing.id}`, { name, emoji, share, take: takeValue(flags) });
        folder = { ...existing, name, emoji };
      } else {
        ({ folder } = await api("POST", "/api/folders", { name, emoji, share, take: takeValue(flags) }));
      }
      await reload(); render(); after(folder);
    }),
    cancel: () => after(existing ?? null),      // 아무것도 바꾸지 않고 물러난다
  });
  const del = sheet.querySelector("#fdel");
  if (del) del.onclick = guard(async () => {
    const yes = await askSure({
      title: "폴더를 삭제할까요?",
      body: `${esc(existing.name)} · ${worksIn(existing.id).length}개. 묶음만 사라지고 작품은 목록에 남습니다.`,
      back: () => openFolderForm(existing, after),
    });
    if (!yes) return;
    await api("DELETE", `/api/folders/${existing.id}`);
    await reload(); render(); after(null);
  });
}

/* 전체 검색 — 어느 구간에 넣었는지 몰라도 제목만으로 찾는다. */
let findQuery = "";

function openFind() {
  findQuery = "";
  const body = () => {
    const q = findQuery.trim().toLowerCase();
    if (!q) return `<div class="empty">작품명을 입력하세요.<br>
      보관함에 있는 것도 함께 찾습니다.</div>`;
    const hit = works.filter(w => w.title.toLowerCase().includes(q));
    if (!hit.length) return `<div class="empty">찾는 작품이 없습니다.</div>`;
    // 보고 있는 목록에 있는 것을 먼저, 내려둔 것은 뒤에
    const rank = w => (w.state === "active" ? 0 : 1);
    return byRecent(hit).sort((a, b) => rank(a) - rank(b))
      .map(w => rowHtml(w, `${platformOf(w.platformId).name}`
        + (w.state === "active" ? "" : ` · ${icon(STATES[w.state].icon)} ${STATES[w.state].label}`)
        + ` · ${ago(w.lastAt)}`)).join("");
  };

  openSheet(`
    ${searchHtml("작품명으로 검색")}
    <div data-find-body>${body()}</div>`,
    { full: true, title: "검색", sub: `전체 ${works.length}편에서 찾습니다` });

  const qEl = sheet.querySelector(".arch-q");
  qEl.addEventListener("input", () => {
    findQuery = qEl.value;
    sheet.querySelector("[data-find-body]").innerHTML = body();
  });
  softFocus(qEl);

  sheet.querySelector(".sheet-body").addEventListener("click", e => {
    const r = e.target.closest(".row[data-id]");
    // 찾던 자리를 잃지 않게 검색 위에 겹친다 — 닫으면 치던 말과 결과가 그대로 있다
    if (r) openWork(r.dataset.id, () => { const keep = findQuery; openFind(); restoreFind(keep); });
  });
}

/* 겹쳐 둔 작품 화면을 닫고 돌아왔을 때, 치던 말과 결과를 되살린다 */
function restoreFind(text) {
  if (!text) return;
  findQuery = text;
  const el = sheet.querySelector(".arch-q");
  if (el) { el.value = text; el.dispatchEvent(new Event("input", { bubbles: true })); }
}

/* 한 구간의 작품을 세로로 전부 펼친다. 홈의 가로 슬라이드는 쌓이면 끝을 못 본다. */
let platQuery = "";

function openPlatformList(pid) {
  platQuery = "";
  drawPlatformList(pid);
}

function drawPlatformList(pid) {
  const p = platformOf(pid);
  const all = byRecent(activeWorks().filter(w => w.platformId === pid));

  const body = () => {
    const q = platQuery.trim().toLowerCase();
    const hits = q ? all.filter(w => w.title.toLowerCase().includes(q)) : all;
    if (!hits.length)
      return `<div class="empty">${q ? "찾는 작품이 없습니다." : "비어 있습니다."}</div>`;
    return (q ? `<div class="rest" style="text-align:left;padding:0 2px 8px">
        &ldquo;${esc(platQuery.trim())}&rdquo; · ${hits.length}편</div>` : "")
      + `<div data-wbar>${workBarHtml(hits.length)}</div>`
      + workGridHtml(hits, "");
  };

  workPickAt("plat:" + pid);           // 다른 구간으로 넘어가면 고른 것은 버린다
  openSheet(`
    ${all.length > 7 ? searchHtml("작품명으로 검색", platQuery) : ""}
    <div data-plat-body>${body()}</div>`,
    { full: true, title: `${esc(p.name)}`, sub: `${all.length}편` });

  const qEl = sheet.querySelector(".arch-q");
  if (qEl) qEl.addEventListener("input", () => {
    platQuery = qEl.value;                       // 결과만 갈아 끼워 포커스를 지킨다
    sheet.querySelector("[data-plat-body]").innerHTML = body();
  });

  wireWorkPick(sheet.querySelector(".sheet-body"), () => drawPlatformList(pid));

  sheet.querySelector(".sheet-body").addEventListener("click", e => {
    if (workSel) return;                 // 고르는 중에는 열어 볼 일이 없다
    const r = e.target.closest(".work[data-id], .row[data-id]");
    if (r) openWork(r.dataset.id, () => drawPlatformList(pid));   // 구간 목록 위에 겹친다
  });
}

/* ── 보관함 ──────────────────────────────────────────────── */
/* 별점 묶음을 폴더처럼 여닫고, 작품명으로 찾는다.
   화면 상태라 시트 밖에 둔다 — 되돌리기·삭제 뒤 다시 그려도 보던 자리가 유지된다. */
let arch = { state: "watched", group: null, q: "", picked: new Set() };

/** 별점 높은 것부터. 안 매긴 것은 섞이지 않게 맨 뒤로 따로 모은다. */
function archGroups(list) {
  const out = [];
  for (let n = MAX_STAR; n >= 1; n--) {
    const items = list.filter(w => w.rating === n);
    if (items.length) out.push({ key: n, label: starText(n), stars: true, items });
  }
  const none = list.filter(w => !w.rating);
  if (none.length) out.push({ key: 0, label: "별점 없음", stars: false, items: none });
  return out;
}

function archRow(w) {
  const p = platformOf(w.platformId);
  /* 감상 완료에서 지우는 건 너무 센 조치다 — 한 단계 물려 휴지통으로 보낸다.
     영구 삭제는 휴지통에서만 할 수 있게 두어, 되돌릴 기회가 항상 한 번은 남는다.
     되묻는 일은 askSure 가 창으로 맡는다 — 한때 이 줄 안에서 글씨를 바꿔 물었는데,
     같은 자리를 두 번 누르는 손짓이라 잘못 누른 사람은 두 번 다 잘못 눌렀다. */
  const trash = arch.state === "watched";
  return `<div class="arch">
    <label class="arch-pick"><input type="checkbox" data-pick="${w.id}"
      ${arch.picked.has(w.id) ? "checked" : ""} aria-label="${esc(w.title)} 선택"></label>
    <span class="thumb" style="${coverStyle(w)}">${coverChar(w)}</span>
    <span class="rt"><b>${esc(w.title)}</b><span>${esc(p.name)}${
      w.rating && archGrouped() ? ` · <i class="stars-h">${starText(w.rating)}</i>` : ""
    } · ${ago(w.lastAt)}</span></span>
    <span class="arch-act">
      <button class="mini-btn" data-restore="${w.id}">되돌리기</button>
      ${trash ? `<button class="mini-btn" data-trash="${w.id}">${icon("trash")} 휴지통</button>`
              : `<button class="mini-btn danger" data-del="${w.id}">삭제</button>`}</span>
  </div>`;
}

/** 지금 화면에 보이는 작품들 — 전체 선택이 "보이는 것"만 집도록 */
function archVisible() {
  const list = worksInState(arch.state);
  const q = arch.q.trim().toLowerCase();
  if (q) return list.filter(w => w.title.toLowerCase().includes(q));
  if (!archGrouped()) return list;             // 휴지통은 한 화면에 다 있다
  if (arch.group === null) return [];          // 묶음 목록 화면에는 항목이 없다
  return archGroups(list).find(g => g.key === arch.group)?.items ?? [];
}

/** 여러 개를 한 번에 처리하는 줄. 고른 게 없으면 나타나지 않는다. */
function archBulk() {
  const n = arch.picked.size;
  if (!n) return "";
  const trash = arch.state === "watched";
  const vis = archVisible();
  const allPicked = vis.length && vis.every(w => arch.picked.has(w.id));
  return `<div class="bulk">
    <b>${n}개 선택</b>
    ${vis.length ? `<button class="mini-btn" data-pick-all>${allPicked ? "전체 해제" : "전체 선택"}</button>` : ""}
    <span class="bulk-act">
      <button class="mini-btn" data-bulk="restore">되돌리기</button>
      ${trash ? `<button class="mini-btn" data-bulk="trash">${icon("trash")} 휴지통</button>`
              : `<button class="mini-btn danger" data-bulk="delete">삭제</button>`}
    </span>
  </div>`;
}

/* 별점으로 묶는 건 감상 완료에서만 뜻이 있다.
   버린 작품에 점수를 매길 일은 없으니, 휴지통은 그냥 한 줄로 펼친다. */
const archGrouped = () => arch.state === "watched";

function archBody() {
  const list = worksInState(arch.state);
  const q = arch.q.trim().toLowerCase();

  // 검색 중에는 묶음을 무시한다 — 어느 별점에 있는지 모르니까 찾는 것이다
  if (q) {
    const hits = list.filter(w => w.title.toLowerCase().includes(q));
    return `<div class="rest" style="text-align:left;padding:0 2px 8px">
        &ldquo;${esc(arch.q.trim())}&rdquo; · ${hits.length}편</div>
      ${hits.length ? hits.map(archRow).join("") : `<div class="empty">찾는 작품이 없습니다.</div>`}`;
  }

  if (!archGrouped())
    return list.length ? list.map(archRow).join("") : `<div class="empty">비어 있습니다.</div>`;

  const groups = archGroups(list);
  if (arch.group === null)
    return groups.length
      ? `<div class="folders">${groups.map(g => `<button class="folder" data-grp="${g.key}">
          <div class="mini">${g.items.slice(0, 4)
            .map(w => `<i style="${coverStyle(w)}"></i>`).join("")}</div>
          <span class="txt"><b${g.stars ? ' class="stars-h"' : ""}>${g.label}</b>
            <span>${g.items.length}편</span></span>
          <span class="chev">${icon("right")}</span></button>`).join("")}</div>`
      : `<div class="empty">비어 있습니다.</div>`;

  const g = groups.find(x => x.key === arch.group);
  // 마지막 항목을 지우면 그 묶음 자체가 없어진다 — 빈 화면에 붙들려 있지 말고 목록으로
  if (!g) { arch.group = null; return archBody(); }

  return `<div class="crumb"><button data-arch-back aria-label="묶음 목록으로">${icon("left")}</button>
      <h3${g.stars ? ' class="stars-h"' : ""}>${g.label}</h3>
      <span class="count">${g.items.length}편</span></div>
    ${g.items.map(archRow).join("")}`;
}

function openArchive(state) {
  arch = { state, group: null, q: "", picked: new Set() };
  drawArchive();
}

function drawArchive() {
  const meta = STATES[arch.state], total = worksInState(arch.state).length;
  openSheet(`
    ${searchHtml("작품명으로 검색", arch.q)}
    <div data-arch-bulk>${archBulk()}</div>
    <div data-arch-body>${archBody()}</div>`,
    { full: true, title: `${icon(meta.icon)} ${meta.label}`, sub: `${meta.desc} · ${total}편` });

  // 글자마다 시트를 통째로 다시 그리면 입력 칸이 포커스를 잃는다 — 결과만 갈아 끼운다
  const repaint = () => {
    sheet.querySelector("[data-arch-bulk]").innerHTML = archBulk();
    sheet.querySelector("[data-arch-body]").innerHTML = archBody();
  };
  const qEl = sheet.querySelector(".arch-q");
  qEl.addEventListener("input", () => { arch.q = qEl.value; repaint(); });

  // 한 건이든 여러 건이든 같은 처리로 모은다
  const apply = async (ids, what) => {
    for (const id of ids) {
      if (what === "restore") await api("PATCH", `/api/works/${id}`, { state: "active" });
      else if (what === "trash") await api("PATCH", `/api/works/${id}`, { state: "dropped" });
      else await api("DELETE", `/api/works/${id}`);
    }
    arch.picked = new Set();
    await reload(); render(); drawArchive();
  };

  /* 버리기·지우기는 한 건이든 여럿이든 같은 말로 묻는다. 닫으면 보던 자리로 되돌린다. */
  const sureAbout = (what, n, title) => askSure(what === "trash"
    ? { title: "휴지통으로 옮길까요?", ok: "휴지통", back: drawArchive,
        body: n === 1 ? `${esc(title ?? "")} 을(를) 휴지통으로 옮깁니다. 거기서 되돌릴 수 있습니다.`
                      : `${n}편을 휴지통으로 옮깁니다. 거기서 되돌릴 수 있습니다.` }
    : { title: "영구 삭제할까요?", ok: "삭제", back: drawArchive,
        body: n === 1 ? `${esc(title ?? "")} 을(를) 완전히 지웁니다. 되돌릴 수 없습니다.`
                      : `${n}편을 완전히 지웁니다. 되돌릴 수 없습니다.` });

  // 리스너는 매번 새로 만들어지는 .sheet-body에 붙인다 — sheet에 붙이면 호출마다 누적된다
  sheet.querySelector(".sheet-body").addEventListener("change", e => {
    const c = e.target.closest("[data-pick]"); if (!c) return;
    if (c.checked) arch.picked.add(c.dataset.pick); else arch.picked.delete(c.dataset.pick);
    sheet.querySelector("[data-arch-bulk]").innerHTML = archBulk();   // 목록은 그대로 둔다
  });

  sheet.querySelector(".sheet-body").addEventListener("click", guard(async e => {
    const g = e.target.closest("[data-grp]");
    if (g) { arch.group = +g.dataset.grp; return repaint(); }
    if (e.target.closest("[data-arch-back]")) { arch.group = null; return repaint(); }

    if (e.target.closest("[data-pick-all]")) {
      const vis = archVisible();
      const allPicked = vis.length && vis.every(w => arch.picked.has(w.id));
      for (const w of vis) allPicked ? arch.picked.delete(w.id) : arch.picked.add(w.id);
      return repaint();
    }

    const bulk = e.target.closest("[data-bulk]");
    if (bulk) {
      const what = bulk.dataset.bulk, ids = [...arch.picked];
      if (what !== "restore" && !await sureAbout(what, ids.length)) return;
      return apply(ids, what);
    }

    const b = e.target.closest("button[data-restore],button[data-trash],button[data-del]");
    if (!b) return;
    const { restore, trash, del } = b.dataset;
    if (restore) return apply([restore], "restore");
    const one = works.find(x => x.id === (trash ?? del));
    if (!await sureAbout(trash ? "trash" : "delete", 1, one?.title)) return;
    return apply([trash ?? del], trash ? "trash" : "delete");
  }));
}

/* ── 추가함 ──────────────────────────────────────────────── */
function openInbox() {
  const n = unfiled().length;
  openSheet(`
    ${headHtml("작품 추가", { back: false, actions: false, sub: "무엇을 하시겠어요?" })}
    <div class="opts">
      <button class="menu-item" data-go="unfiled" style="border:1px solid var(--line-2);border-radius:11px">
        <span class="mi">✨</span><span class="mt">새 콘텐츠${n ? `<span class="mt-count">${n}</span>` : ""}
        <small>${n ? "공유로 받은 작품을 정리합니다" : "정리할 작품이 없습니다"}</small></span></button>
      <button class="menu-item" data-go="url" style="border:1px solid var(--line-2);border-radius:11px">
        <span class="mi">🔗</span><span class="mt">URL 추가<small>주소를 붙여넣어 목록에 담기</small></span></button>
      <button class="menu-item" data-go="manual" style="border:1px solid var(--line-2);border-radius:11px">
        <span class="mi">${icon("pencil")}</span><span class="mt">직접 입력<small>주소 없이 제목과 일정만으로</small></span></button>
    </div>`);
  sheet.querySelector('[data-go="unfiled"]').onclick = openUnfiled;
  sheet.querySelector('[data-go="url"]').onclick = () => openAdd();
  sheet.querySelector('[data-go="manual"]').onclick = openManual;
}

function openUnfiled() {
  const list = unfiled();
  openSheet(`
    ${headHtml("새 콘텐츠", { actions: false })}
    <p class="sub">공유로 받아 아직 정리하지 않은 작품 ${list.length}편</p>
    <div class="uf-list">${list.length ? list.map(w => {
      const p = platformOf(w.platformId);
      return `<button class="uf-item" data-uf="${w.id}">
        <span class="thumb" style="${coverStyle(w)}">${coverChar(w)}</span>
        <span class="ub"><b>${esc(w.title)}</b><span>${esc(p.name)} · ${esc(schedText(w))}</span></span>
        <span class="chev">${icon("right")}</span></button>`;
    }).join("") : `<div class="empty">모두 정리했습니다.<br>다른 앱에서 공유하면 여기에 쌓입니다.</div>`}</div>`);
  sheet.querySelector("[data-head-back]").onclick = openInbox;
  sheet.querySelector(".uf-list").addEventListener("click", e => {
    const b = e.target.closest("[data-uf]"); if (!b) return;
    openWorkSettings(b.dataset.uf, { back: openUnfiled, mode: "add" });
  });
}

/* fromShare — 다른 앱의 공유 시트에서 넘어온 경우.
   직접 추가는 이 화면에서 제목·일정·폴더를 다 정하고 들어오므로 정리가 끝난 것으로 본다.
   공유는 하던 일로 빨리 돌아가야 하니 미정 상태로 담고 "새 콘텐츠"에서 나중에 정리한다. */
/* 주소 없이 제목만으로 담기.
   "9월 12일에 그 영화 개봉" 처럼, 기다리는 것에는 아직 페이지가 없을 때가 있다. */
function openManual() {
  /* 제목을 draft 에 함께 담는다. 새 폴더를 만들러 갔다 오면 이 시트가 덮여 있어
     그때 칸에서 읽을 수 없다 — 치는 동안 담아 둬야 들고 돌아올 수 있다. */
  const draft = { title: "", schedule: { mode: "dated", days: [], next: null },
                  folders: [], color: null };

  const paint = () => {
    const box = sheet.querySelector("[data-manual-body]");
    const fallback = platformOf("note").color;
    box.innerHTML = `${schedHtml(draft.schedule, "언제 나오는지 알면 골라주세요",
      { value: draft.color, fallback })}
      ${pickerHtml(draft.folders)}
      ${actionRow("do-manual", "목록에 등록")}`;
    wireSched(box, draft.schedule, redraw => { if (redraw) paint(); });
    wireColorPicker(box, draft, fallback);
    wirePicker(box, draft.folders, () => {}, () => shell(draft.title));
    box.querySelector("#do-manual").onclick = guard(async () => {
      const el = sheet.querySelector("#man-title");
      const title = el.value.trim();
      if (!title) { el.focus(); return; }
      await api("POST", "/api/works",
        { title, schedule: draft.schedule, folders: draft.folders, color: draft.color });
      await reload(); tab = "cal"; render(); closeSheet();
      toast(`«${title}» 목록에 담았습니다`);
    });
  };

  /* 시트를 통째로 다시 그린다. 새 폴더를 만들고 돌아올 때 필요하다 —
     폴더 창이 이 시트를 덮어썼으므로 안쪽만 고쳐서는 되살아나지 않는다.
     치던 제목은 들고 넘어간다. */
  const shell = (title = "") => {
    openSheet(`
      ${headHtml("직접 입력", { save: "담기" })}
      <p class="sub">주소가 없어도 됩니다. 제목과 날짜만 있으면 캘린더에 놓입니다.</p>
      <div class="field"><label for="man-title">제목</label>
        <input id="man-title" value="${esc(title)}" placeholder="예: 듄 파트3" maxlength="120"></div>
      <div data-manual-body></div>`);
    const el = sheet.querySelector("#man-title");
    draft.title = el.value;
    el.addEventListener("input", () => { draft.title = el.value; });
    // 담기 버튼은 paint() 가 그릴 때마다 새로 생긴다 — 머리줄에서는 그것을 눌러 준다
    wireHead({ save: () => sheet.querySelector("#do-manual")?.click(), cancel: openInbox });
    paint();
  };

  shell();
  softFocus(sheet.querySelector("#man-title"));
}

function openAdd(prefill, fromShare) {
  let resolved = null, seq = 0, timer = null, input, preview;
  const draft = { schedule: { mode: "unknown", days: [], next: null }, folders: [], color: null };

  /* 시트를 통째로 그린다. 새 폴더를 만들고 돌아올 때 다시 부른다 — 폴더 창이 이 시트를
     덮어썼으므로 안쪽만 고쳐서는 되살아나지 않는다. 치던 주소는 들고 넘어간다. */
  const shell = (url = "") => {
    openSheet(`
      ${headHtml("URL 추가", { save: "담기" })}
      <p class="sub">작품 주소를 붙여넣으세요. 다른 앱에서 공유 버튼으로 보내도 이 화면이 열립니다.</p>
      <div class="field"><label for="in-url">URL</label>
        <textarea id="in-url" spellcheck="false" placeholder="https://…">${esc(url)}</textarea></div>
      <div id="add-preview"></div>`);

    input = sheet.querySelector("#in-url");
    preview = sheet.querySelector("#add-preview");
    // 등록 버튼은 주소를 확인한 뒤에야 생긴다 — 머리줄에서는 그것을 눌러 준다
    wireHead({
      save: () => {
        const add = sheet.querySelector("#do-add");
        if (add) add.click(); else toast("주소를 먼저 넣어 주세요");
      },
      cancel: openInbox,
    });
    input.addEventListener("input", () => {
      draft.url = input.value;              // 새 폴더에 다녀와도 들고 돌아오려고
      clearTimeout(timer);
      timer = setTimeout(lookup, 400);
    });
    draft.url = input.value;
  };

  const paint = () => {
    if (!resolved) { preview.innerHTML = ""; return; }
    if (!resolved.ok) { preview.innerHTML = `<div class="note">${esc(resolved.reason)}</div>`; return; }
    const auto = resolved.origin === "og";
    preview.innerHTML = `
      ${resolved.note ? `<div class="note sep">${esc(resolved.note)}</div>` : ""}
      <div class="sep">
      <dl class="kv"><dt>플랫폼</dt><dd>${esc(resolved.platform.name)} · ${MEDIA[resolved.mediaType] ?? "링크"}</dd></dl>
      <div class="field" style="margin-bottom:0">
        <label for="in-title">제목
          <span style="text-transform:none;letter-spacing:0">— <span style="color:var(--${auto ? "good" : "warn"})">${auto ? "자동" : "직접 입력"}</span> · ${esc(resolved.originLabel)}</span>
        </label>
        <input id="in-title" value="${esc(resolved.title)}" placeholder="작품 제목을 입력하세요"></div></div>
      ${schedHtml(draft.schedule, "어느 플랫폼도 공개하지 않아 직접 고릅니다. 한 번만 정하면 됩니다",
        { value: draft.color, fallback: resolved.platform.color })}
      ${pickerHtml(draft.folders)}
      ${actionRow("do-add", "목록에 등록")}`;
    wireSched(preview, draft.schedule, redraw => { if (redraw) paint(); });
    wireColorPicker(preview, draft, resolved.platform.color);
    /* 새 폴더를 만들고 돌아오면 이 시트가 덮여 있다 — 통째로 다시 그린 뒤 미리보기를 채운다.
       주소는 이미 확인해 두었으므로 다시 물어보지 않는다. */
    wirePicker(preview, draft.folders, () => {}, () => { shell(draft.url); paint(); });
    preview.querySelector("#do-add").onclick = guard(async () => {
      const titleEl = preview.querySelector("#in-title");
      const title = titleEl.value.trim();
      if (!title) { titleEl.focus(); return; }
      const filed = !fromShare || draft.folders.length > 0;
      await api("POST", "/api/works", {
        url: input.value, title, schedule: draft.schedule,
        folders: draft.folders, color: draft.color, filed,
      });
      await reload(); tab = "home"; openFolderId = null; render(); closeSheet();
      fillSiteNames();          // 새 도메인이면 이름을 곧바로 받아 온다
      toast(filed ? `«${title}» 목록에 담았습니다`
                  : `«${title}» 담았습니다 · 새 콘텐츠에서 정리할 수 있어요`);
    });
  };

  const lookup = () => {
    const value = input.value.trim();
    if (!value) { resolved = null; paint(); return; }
    const mine = ++seq;
    preview.innerHTML = `<div class="note">확인 중…</div>`;
    api("POST", "/api/resolve", { url: value })
      .then(r => { if (mine !== seq) return; resolved = r; Object.assign(draft.schedule, r.schedule); paint(); })
      .catch(err => { if (mine !== seq) return; resolved = { ok: false, reason: err.message }; paint(); });
  };

  shell(prefill ?? "");
  if (prefill) lookup();
  softFocus(input);
}

/* ── 플랫폼 표시 설정 ────────────────────────────────────── */
function readableOn(hex) {
  const h = hex.replace("#", "");
  const lin = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? "#1B1B1B" : "#FFFFFF";
}

function openPlatformEdit(platformId) {
  const p = platformOf(platformId);
  // fg 가 null 이면 "배경에 맞춰 알아서" 라는 뜻이다
  const draft = { name: p.overridden ? p.name : "", initial: p.initial, color: p.color,
                  fg: p.fgSet ? p.fg : null };
  // 이미 손봐 둔 플랫폼이면 마크도 그대로 둔다. 처음 이름 짓는 중이라면 이름을 따라간다.
  let markEdited = p.overridden;
  const paint = () => {
    const initEl = sheet.querySelector("#dom-init");
    draft.name = sheet.querySelector("#dom-name").value;
    // 이름만 지어놓고 마크가 "?"로 남는 일이 없게 첫 글자를 따라 붙인다
    if (!markEdited) initEl.value = [...draft.name.trim()][0] ?? p.baseInitial;
    draft.initial = initEl.value.trim() || p.baseInitial;
    const mark = sheet.querySelector(".dom-preview .pmark");
    const c = draft.color ?? p.baseColor;
    mark.textContent = draft.initial;
    mark.style.background = c;
    mark.style.color = draft.fg ?? readableOn(c);
    for (const b of sheet.querySelectorAll("[data-fg] button"))
      b.setAttribute("aria-pressed", (b.dataset.fg || null) === draft.fg);
    sheet.querySelector(".dom-preview b").textContent = draft.name.trim() || p.baseName;
    paintTwin();
  };

  /* 한 사이트가 호스트별로 갈려 있을 때 합치는 길 —
     product.kyobobook.co.kr 과 event.kyobobook.co.kr 처럼.
     이름을 치는 동안 비슷한 구간을 보여주고, 고르면 합칠지 묻는다. */
  const countOf = id => works.filter(w => w.platformId === id).length;
  let wide = false;   // "이 도메인 아래 전부" 선택 여부 — 다시 그려도 남아야 한다

  const candidates = () => {
    if (!p.isDomain) return [];
    const n = draft.name.trim().toLowerCase();
    if (!n) return [];
    return Object.values(platforms)
      .filter(x => x.id !== platformId && x.isDomain && countOf(x.id))
      .map(x => ({ p: x, n: x.name.trim().toLowerCase() }))
      // 이름이든 주소든 걸리면 후보다 — "교보문고"로도 "kyobo"로도 찾을 수 있게
      .filter(x => x.n.includes(n) || n.includes(x.n) || x.p.host.includes(n))
      .sort((a, b) => (a.n === n ? -1 : b.n === n ? 1 : a.n.localeCompare(b.n)))
      .slice(0, 6);
  };

  const paintTwin = () => {
    const box = sheet.querySelector("[data-twin]"); if (!box) return;
    const list = candidates();
    const exact = list.find(x => x.n === draft.name.trim().toLowerCase())?.p;

    if (exact) {                       // 이름이 딱 맞으면 바로 합칠지 묻는다
      box.innerHTML = `<div class="twin">
        <div class="twin-top"><b>${esc(exact.name)}</b> 구간이 이미 있습니다
          <span>${esc(exact.host)} · ${countOf(exact.id)}편</span></div>
        ${p.domainBase ? `<label class="twin-wide">
          <input type="checkbox" data-wide ${wide ? "checked" : ""}>
          앞으로 <b>*.${esc(p.domainBase)}</b> 도 전부 여기로</label>` : ""}
        <button class="btn" data-merge="${esc(exact.id)}">한 단락으로 합치기</button></div>`;
      return;
    }
    box.innerHTML = !list.length ? "" : `<div class="twin-list">
      <span class="twin-h">비슷한 이름의 구간 — 누르면 합칠 수 있습니다</span>
      ${list.map(({ p: x }) => `<button data-pick="${esc(x.name)}">
        <b>${esc(x.name)}</b><span>${esc(x.host)} · ${countOf(x.id)}편</span></button>`).join("")}</div>`;
  };
  openSheet(`
    ${headHtml("표시 설정", { back: false, sub: p.isDomain
      ? `${esc(p.host)}의 작품을 한 묶음으로 보여줍니다.`
      : `기본값은 ${esc(p.baseName)} · ${esc(p.baseInitial)} 입니다.` })}
    <div class="dom-preview">
      <span class="pmark" style="background:${draft.color};color:${draft.fg ?? readableOn(draft.color)}">${esc(draft.initial)}</span>
      <b>${esc(draft.name || p.baseName)}</b>${p.isDomain ? `<em>${esc(p.host)}</em>` : ""}</div>
    <div class="field"><label for="dom-name">이름</label>
      <input id="dom-name" value="${esc(draft.name)}" placeholder="${esc(p.baseName)}" maxlength="20"></div>
    <div class="field"><label for="dom-init">마크 <span style="text-transform:none;letter-spacing:0">— 목록에 붙는 한두 글자</span></label>
      <input id="dom-init" value="${esc(draft.initial)}" maxlength="2" style="width:80px"></div>
    ${colorPickerHtml(draft.color === p.baseColor ? null : draft.color, p.baseColor, "색", "기본색")}
    <div class="field"><label>마크 글자색</label>
      <div class="pickers" data-fg>
        <button class="pick" type="button" data-fg="" aria-pressed="${!draft.fg}">자동</button>
        <button class="pick" type="button" data-fg="#FFFFFF" aria-pressed="${draft.fg === "#FFFFFF"}">흰색</button>
        <button class="pick" type="button" data-fg="#1B1B1B" aria-pressed="${draft.fg === "#1B1B1B"}">검정</button>
      </div></div>
    ${p.isDomain ? `<div class="rest" style="text-align:left;padding:0 2px 8px">
      비워 두면 사이트가 밝힌 이름을 씁니다.
      <button class="linky" data-fetch-name>사이트에서 가져오기</button></div>` : ""}
    <div data-twin></div>
    ${p.isDomain && p.hosts.length > 1 ? `<div class="field"><label>담긴 주소</label>
      <div class="hosts">${p.hosts.map(h => `<div class="host-row">
        <span>${esc(h)}</span>
        ${h === p.host ? `<em>본래 주소</em>`
          : `<button class="mini-btn" data-split="${esc(h)}">떼어내기</button>`}
      </div>`).join("")}</div>
      <div class="rest" style="text-align:left;padding:6px 2px 0">
        떼어내면 그 주소의 작품만 따로 나가고, 앞으로도 합쳐지지 않습니다.</div></div>` : ""}
    ${p.overridden ? `<div class="link-row"><button class="btn" data-reset>기본값으로</button></div>` : ""}
    <div class="link-row wide-only" style="margin-top:4px">
      <button class="btn" data-cancel>취소</button>
      <button class="btn primary" data-done>저장</button></div>`);
  sheet.querySelector("[data-fg]").addEventListener("click", e => {
    const b = e.target.closest("button[data-fg]"); if (!b) return;
    draft.fg = b.dataset.fg || null;
    paint();
  });
  sheet.querySelector("#dom-name").addEventListener("input", paint);
  sheet.querySelector("#dom-init").addEventListener("input", () => { markEdited = true; paint(); });
  // 도메인 색은 비울 수 없다 — "기본색" 은 플랫폼 기본값으로 되돌린다
  wireColorPicker(sheet, draft, p.baseColor, { nullable: false, onChange: paint });
  wireHead({ save: () => saveDomain(), cancel: () => { closeSheet(); render(); } });
  const saveDomain = guard(async () => {
    await api("PUT", `/api/overrides/${encodeURIComponent(platformId)}`,
      { name: draft.name.trim() || p.baseName, initial: draft.initial,
        color: draft.color ?? p.baseColor, fg: draft.fg });
    await reload(); render(); closeSheet();
  });
  sheet.querySelector("[data-twin]").addEventListener("click", guard(async e => {
    // 후보를 고르면 그 이름을 채워 넣는다 — 그러면 위 분기가 합치기로 바뀐다
    const pick = e.target.closest("[data-pick]");
    if (pick) {
      const el = sheet.querySelector("#dom-name");
      el.value = pick.dataset.pick;
      el.focus();
      paint();
      return;
    }
    if (e.target.closest("[data-wide]")) { wide = e.target.checked; return; }

    const b = e.target.closest("[data-merge]"); if (!b) return;
    const r = await api("POST", "/api/platforms/merge",
      { from: platformId, to: b.dataset.merge, wide });
    await reload(); render(); closeSheet();
    toast(`${r.platform.name}${ro(r.platform.name)} 합쳤습니다 · ${r.moved}편`
      + (r.merged > 1 ? ` (${r.merged}개 구간)` : ""));
  }));

  const hostsBox = sheet.querySelector(".hosts");
  if (hostsBox) hostsBox.addEventListener("click", guard(async e => {
    const b = e.target.closest("[data-split]"); if (!b) return;
    const r = await api("POST", "/api/platforms/split", { platformId, host: b.dataset.split });
    await reload(); render(); closeSheet();
    toast(`${b.dataset.split}${ro(b.dataset.split)} 떼어냈습니다 · ${r.moved}편`);
  }));

  const fetchBtn = sheet.querySelector("[data-fetch-name]");
  if (fetchBtn) fetchBtn.onclick = guard(async () => {
    fetchBtn.disabled = true; fetchBtn.textContent = "가져오는 중…";
    const r = await api("POST", `/api/platforms/${encodeURIComponent(platformId)}/site-name`);
    if (!r.ok) { toast(r.reason); fetchBtn.disabled = false; fetchBtn.textContent = "사이트에서 가져오기"; return; }
    await reload(); render(); closeSheet(); openPlatformEdit(platformId);
    toast(`사이트 이름: ${r.name}`);
  });

  const reset = sheet.querySelector("[data-reset]");
  if (reset) reset.onclick = guard(async () => {
    const yes = await askSure({
      title: "기본값으로 되돌릴까요?",
      body: "이 사이트에 손수 정한 이름·색·아이콘이 사라집니다.",
      ok: "되돌리기", back: () => openPlatformEdit(platformId),
    });
    if (!yes) return;
    await api("DELETE", `/api/overrides/${encodeURIComponent(platformId)}`);
    await reload(); render(); closeSheet();
  });
  paint();
}

function openInviteAccept(code, from) {
  openSheet(`
    ${headHtml("친구 요청", { back: false, actions: false,
      sub: `<b>${esc(from.displayName)}</b>님이 친구로 초대했습니다.` })}
    <div class="rest" style="text-align:left;padding:0 2px 14px">
      친구가 되면 서로 <b>공개로 표시한 폴더</b>를 볼 수 있습니다.
      공개하지 않은 폴더와 나머지 기록은 보이지 않습니다.</div>
    <div class="link-row">
      <button class="btn" data-no>나중에</button>
      <button class="btn primary" data-yes>친구 맺기</button>
    </div>`);
  sheet.querySelector("[data-no]").onclick = closeSheet;
  sheet.querySelector("[data-yes]").onclick = guard(async () => {
    if (!me.displayName) { openNameForm(() => openInviteAccept(code, from)); return; }
    await api("POST", `/api/invites/${code}/accept`);
    await reload(); render(); closeSheet();
    toast(`${from.displayName}님과 친구가 되었습니다`);
  });
}

/* ── 표시 이름 ───────────────────────────────────────────
   친구에게 보이는 유일한 신원. 카카오 프로필을 받지 않으므로 여기서 직접 정한다. */
function openNameForm(after) {
  openSheet(`
    ${headHtml(me.displayName ? "이름 바꾸기" : "이름 정하기", { back: false })}
    <div class="field"><label for="dname">표시 이름</label>
      <input id="dname" value="${esc(me.displayName ?? "")}" placeholder="예: 영수" maxlength="20"
        autocomplete="off" spellcheck="false"></div>
    ${/* 이름은 겹칠 수 없다. 그것을 **미리** 적어 두고, 겹쳤는지는 저장할 때 한 번 본다 —
         치는 동안 물어보면 글자마다 서버를 두드리게 되고, 규칙을 알려 주는 일에 그만한
         값을 치를 이유가 없다. */""}
    <div class="rest" style="text-align:left;padding:0 2px" data-nfree>
      친구에게 보이는 유일한 이름이라 다른 사람과 겹칠 수 없습니다.</div>
    <div class="link-row wide-only">
      <button class="btn" data-cancel>취소</button>
      <button class="btn primary" data-done>저장</button></div>`);
  const el = sheet.querySelector("#dname");
  const note = sheet.querySelector("[data-nfree]");
  // 고치기 시작하면 지난번에 걸렸던 말을 지운다 — 그건 그때 친 이름의 이야기다
  el.addEventListener("input", () => {
    if (!note.style.color) return;
    note.textContent = "친구에게 보이는 유일한 이름이라 다른 사람과 겹칠 수 없습니다.";
    note.style.color = "";
  });

  wireHead({ save: () => saveName(), cancel: () => closeSheet() });
  const saveName = guard(async () => {
    const v = el.value.trim();
    if (!v) { el.focus(); return; }
    try {
      await api("PUT", "/api/me", { displayName: v });
    } catch (e) {
      // 겹치는 이름은 저장되지 않는다 — 창을 닫지 말고 그 자리에서 고치게 한다
      note.textContent = e.message;
      note.style.color = "var(--bad-ink)";
      el.focus(); el.select();
      return;
    }
    toast("저장되었습니다");
    await reload(); render();
    after ? after() : closeSheet();
  });
  softFocus(el);
}

/* ── 친구 ────────────────────────────────────────────────── */
/** 친구 목록 — 별을 켜고 끄는 곳은 여기 하나뿐이다.

    친구가 수백 명이 되면 훑어서는 못 찾는다. 두 갈래를 둔다 — 이름을 알면 **찾기**,
    자주 보는 사람이면 **즐겨찾기**. 유튜브 댓글처럼 끊어 불러오지는 않는다:
    댓글은 흘려 읽는 강이지만 친구 목록은 한 사람을 짚는 명부라, 화면에 없는 사람은
    찾을 수 없게 되어 찾기 자체가 망가진다. 200명이라도 17KB면 다 온다. */
async function openFriends() {
  if (!me.displayName) { openNameForm(openFriends); return; }
  try { await loadFriends(); } catch (e) { toast(e.message); return; }
  let query = "", onlyStar = false;
  /* 여럿을 한 번에 끊는 자리. null 이면 그냥 보는 중이고, Set 이면 고르는 중이다 —
     폴더 목록의 folderSel 과 같은 규칙이라 두 화면이 같은 손짓으로 움직인다. */
  let sel = null;

  const row = f => `<div class="uf-row">
    ${sel ? `<label class="arch-pick"><input type="checkbox" data-fpick="${esc(f.id)}"
      ${sel.has(f.id) ? "checked" : ""} aria-label="${esc(f.displayName)} 선택"></label>` : ""}
    ${/* 머리글자 상자는 두지 않는다 — 바로 옆에 이름이 통째로 있어 같은 글자를 두 번
         보여 줄 뿐이고, 그만큼 줄이 두꺼워져 한 화면에 담기는 사람이 줄어든다. */""}
    <button class="uf-item" data-friend="${esc(f.id)}">
      <span class="ub"><b>${esc(f.displayName)}</b>
        <span>${f.sharedFolders ? `나에게 공개한 폴더 ${f.sharedFolders}개` : "나에게 공개한 폴더 없음"}</span></span>
      ${/* 화살표는 두지 않는다 — 이 목록의 줄은 전부 눌리는 것이라 하나하나에 "눌러도
           된다" 를 붙일 이유가 없고, 그만큼 이름 쓸 자리가 좁아진다. */""}</button>
    ${sel ? "" : starHtml(f)}</div>`;

  /* 목록은 **첫소리 차례**다. 오른쪽 ㄱㄴㄷ 띠를 짚어 뛰려면 차례가 그 띠와 같아야 한다 —
     별 켠 사람을 위로 올리던 것은 여기서 놓는다. 자주 보는 사람만 보려면 ★ 단추가 있다. */
  const rows = () => {
    const q = query.trim().toLowerCase();
    let list = onlyStar ? friends.filter(f => f.starred) : friends;
    if (q) list = list.filter(f => f.displayName.toLowerCase().includes(q));
    if (!list.length)
      return `<div class="empty">${
        q ? "찾는 이름이 없습니다."
          : onlyStar ? "즐겨찾기에 넣은 친구가 없습니다.<br>목록에서 별을 눌러 보세요."
            : "아직 친구가 없습니다.<br>초대 링크를 보내보세요."}</div>`;
    // 찾는 중이거나 즐겨찾기만 볼 때는 묶지 않는다 — 몇 줄뿐이라 머리글이 짐이 된다
    if (q || onlyStar) return list.map(row).join("");
    return byInitial(list).map(g => `<div class="cho-h" data-cho="${g.key}">${g.key}</div>`
      + g.items.map(row).join("")).join("");
  };

  /* 오른쪽 가장자리의 첫소리 띠. 짚어서 그대로 끌면 목록이 따라 움직인다.
     그 칸에 아무도 없으면 흐리게 두되 자리는 지킨다 — 띠가 짧아졌다 길어졌다 하면
     같은 자리를 짚어도 매번 다른 데로 간다. */
  const railHtml = () => {
    const have = new Set(byInitial(friends).map(g => g.key));
    return `<div class="cho-rail" data-cho-rail aria-hidden="true">${INDEX_KEYS
      .map(k => `<i data-k="${k}"${have.has(k) ? "" : ' class="off"'}>${k}</i>`).join("")}</div>`;
  };

  const starred = () => friends.filter(f => f.starred).length;

  /* 지금 **화면에 서 있는** 사람들. 찾기나 즐겨찾기로 좁혀 놓았으면 그만큼만이다 —
     「전체 선택」이 안 보이는 사람까지 집으면 못 본 채로 끊게 된다. */
  const shown = () => {
    const q = query.trim().toLowerCase();
    let list = onlyStar ? friends.filter(f => f.starred) : friends;
    return q ? list.filter(f => f.displayName.toLowerCase().includes(q)) : list;
  };

  /** 목록 위 줄 — 찾기와 즐겨찾기는 늘 있고, 고르는 중에는 셈과 실행이 아래 붙는다.

      **고르는 중에도 찾기를 남긴다.** 좁혀 놓은 채로 고르기에 들어가면 목록이 짧은데,
      그 까닭인 찾기 칸까지 사라지면 왜 두 명뿐인지 알 길이 없다. 스물다섯 명에서 한 명을
      끊으려고 이름을 치는 것도 여기서 하는 일이다. */
  const barHtml = () => {
    if (!friends.length) return "";
    const top = `<div class="fr-bar">
      ${friends.length > 6 ? searchHtml("이름으로 찾기", query) : ""}
      <button class="mini-btn" data-only-star aria-pressed="${onlyStar}"
        >${icon("star")} 즐겨찾기</button>
    </div>`;
    return top + `<div data-fr-bulk>${bulkHtml()}</div>`;
  };

  /* 셈이 바뀔 때 갈아 끼우는 것은 **이 조각뿐**이다 — 위의 찾기 칸까지 함께 다시 그리면
     이름을 치다가 네모칸을 하나 누른 순간 치던 글자가 끊긴다. */
  const bulkHtml = () => {
    // 고르기 전에는 「선택」 하나만. 왼쪽 끝에 두어 찾기 칸의 왼쪽 모서리와 줄을 맞춘다.
    if (!sel) return `<div class="fr-pick"><button class="mini-btn" data-fsel>선택</button></div>`;
    /* 「전체 선택」은 **지금 화면에 서 있는 사람만** 집는다 — 찾기나 즐겨찾기로 좁혀
       놓았으면 그만큼이다. 안 보이는 사람까지 집으면 못 본 채로 끊게 된다.
       단추 하나가 상황을 따라 이름을 바꾼다(폴더 목록과 같은 규칙) — 다 골라 놓고
       무르고 싶을 때 누를 것을 따로 찾지 않아도 된다. */
    const vis = shown();
    const allPicked = vis.length > 0 && vis.every(f => sel.has(f.id));
    return `<div class="bulk">
      <b>${sel.size}명 선택</b>
      ${vis.length ? `<button class="mini-btn" data-fsel-all>${
        allPicked ? "전체 해제" : "전체 선택"}</button>` : ""}
      <span class="bulk-act">
        <button class="mini-btn danger" data-fsel-del${sel.size ? "" : " disabled"}>친구 끊기</button>
        <button class="mini-btn" data-fsel-off>완료</button>
      </span></div>`;
  };

  /* 초대 링크는 맨 위에 둔다. 아래에 있으면 친구가 쌓일수록 손이 멀어지는데,
     이 화면에서 새로 하는 일은 그것 하나뿐이다. */
  openSheet(`
    ${headHtml("친구", { back: false, actions: false,
      sub: `${friends.length}명` })}
    <button class="btn primary" style="width:100%" data-invite>초대 링크 만들기</button>
    <div class="rest" style="text-align:left;padding:7px 2px 12px">
      링크를 받은 사람만 친구가 될 수 있습니다. 아이디로 검색해 아무나 추가하는 방식이 아닙니다.</div>
    <div data-fr-bar>${barHtml()}</div>
    <div class="fr-wrap">
      <div class="fr-list" data-fr-list>${rows()}</div>
      ${friends.length > 12 ? railHtml() : ""}
    </div>
    ${/* 마지막 칸도 맨 위까지 올라올 수 있게 뒤에 빈 자리를 둔다 — 얼마나 둘지는
         화면 크기에 달렸으므로 아래에서 재서 정한다 */""}
    <div class="fr-pad"></div>`, { flush: true });

  const list = sheet.querySelector("[data-fr-list]");

  /* 그 칸의 머리글이 통 맨 위에 서려면 얼마나 굴러야 하는지.

     머리글(.cho-h)은 **붙어 있어서**(sticky) 제 자리를 알려 주지 못한다 — 이미 지나온
     칸은 모두 통 꼭대기에 겹쳐 서 있고, 그때 재면 어느 칸이든 같은 값이 나온다.
     붙어 있지 않은 **다음 줄**로 재고 머리글 높이만큼 물린다. */
  const headAt = (body, head) =>
    posIn(body, head.nextElementSibling ?? head) - head.offsetHeight;

  /* 마지막 칸도 맨 위까지 올라오려면 그 아래에 통 하나만큼이 남아 있어야 한다.
     :last-of-type 은 **태그**로 세므로 쓰지 않는다 — 머리글도 줄도 div 라 마지막 div 는
     늘 줄이었고 아무것도 안 잡혔다. */
  const fitPad = () => {
    const pad = sheet.querySelector(".fr-pad"), body = sheet.querySelector(".sheet-body");
    const heads = list.querySelectorAll(".cho-h");
    const last = heads[heads.length - 1];
    if (!pad) return;
    if (!last) { pad.style.height = "0px"; return; }
    padToReach(body, headAt(body, last), pad);
  };

  const repaint = () => { list.innerHTML = rows(); fitPad(); };
  fitPad();

  /* 줄 위 칸을 다시 그린다. **찾기 칸을 살려 두려면** 고르는 중일 때만 통째로 갈고,
     평소에는 손대지 않는다 — 치는 도중에 칸이 사라지면 한글이 깨진다. */
  const bar = sheet.querySelector("[data-fr-bar]");
  // 갈래가 바뀔 때만 통째로. 셈만 바뀌면 아래쪽 조각만 간다.
  const repaintBar = () => { bar.innerHTML = barHtml(); wireBar(); };
  const repaintBulk = () => {
    const box = bar.querySelector("[data-fr-bulk]");
    if (!box) return;
    box.innerHTML = bulkHtml();
    wireBulk();
  };

  function wireBulk() {
    const off = bar.querySelector("[data-fsel-off]");
    if (off) off.onclick = () => { sel = null; repaintBar(); repaint(); };
    const all = bar.querySelector("[data-fsel-all]");
    if (all) all.onclick = () => {
      // 보이는 사람만 집고 푼다 — 좁혀 놓은 화면에서 안 보이는 사람이 딸려 오면 안 된다
      const vis = shown();
      if (vis.length && vis.every(f => sel.has(f.id))) for (const f of vis) sel.delete(f.id);
      else for (const f of vis) sel.add(f.id);
      repaintBulk(); repaint();
    };
    const del = bar.querySelector("[data-fsel-del]");
    if (del) del.onclick = cutFriends;
    // 「선택」은 이제 아래 줄에 있다 — 갈래가 바뀌므로 칸을 통째로 다시 그린다
    const on = bar.querySelector("[data-fsel]");
    if (on) on.onclick = () => { sel = new Set(); repaintBar(); repaint(); };
  }

  function wireBar() {
    wireBulk();

    /* 찾기 칸을 치는 동안에는 **줄 위 칸을 다시 그리지 않는다** — 갈아 끼우면 치던 칸이
       사라졌다 새로 생겨서 한글처럼 모아 쓰는 글자가 깨진다. 갈아 끼우는 것은 목록뿐이다. */
    const q2 = bar.querySelector(".arch-q");
    if (q2) q2.addEventListener("input", () => {
      query = q2.value;
      repaint();
      /* 「전체 선택 / 해제」는 **보이는 사람**을 보고 글자를 정한다. 좁히거나 넓히면
         보이는 사람이 달라지므로 그 글자도 다시 세야 한다 — 안 그러면 일곱 중 넷만
         골라 놓고 「전체 해제」라 적혀 있다. 갈아 끼우는 것은 아래 셈줄뿐이라
         치던 칸은 그대로 남는다. */
      repaintBulk();
    });

    const st = bar.querySelector("[data-only-star]");
    if (st) {
      /* 이름이 바깥의 paintStar(별 하나를 칠하는 것)와 겹치면 안 된다 — 여기 것은
         즐겨찾기 **거르개**를 칠한다. 같은 이름이면 읽는 사람이 매번 어느 쪽인지 가려야 한다. */
      const paintFilter = () => {
        st.classList.toggle("on", onlyStar);
        st.setAttribute("aria-pressed", onlyStar);
        st.innerHTML = onlyStar ? icon("star", "on") + ` 즐겨찾기 ${starred()}명`
          : icon("star") + " 즐겨찾기";
      };
      paintFilter();
      // 제 글자만 고쳐 쓴다 — 옆의 찾기 칸을 함께 갈아 끼울 이유가 없다
      st.onclick = () => { onlyStar = !onlyStar; paintFilter(); repaint(); repaintBulk(); };
    }
  }

  /** 고른 사람들을 한꺼번에 끊는다 */
  const cutFriends = guard(async () => {
    const ids = [...sel];
    if (!ids.length) return;
    const names = ids.map(id => friends.find(f => f.id === id)?.displayName).filter(Boolean);
    const yes = await askSure({
      title: `${ids.length}명과 친구를 끊을까요?`,
      ok: "친구 끊기", back: openFriends,
      body: `${esc(names.slice(0, 3).join(", "))}${names.length > 3 ? ` 외 ${names.length - 3}명` : ""}과
        서로의 공개 폴더가 보이지 않게 됩니다. 담아 둔 작품은 그대로 남습니다.`,
    });
    if (!yes) return;
    for (const id of ids) await api("DELETE", `/api/friends/${id}`);
    // 보고 있던 사람을 끊었으면 그 폴더를 계속 둘 수 없다
    if (viewing && ids.includes(viewing.id)) viewing = null;
    await reload(); render();
    toast(`${ids.length}명과 친구를 끊었습니다`);
    openFriends();
  });

  /* 띠를 짚거나 끌면 그 첫소리의 머리글로 뛴다. 누르는 것과 끄는 것을 가르지 않는다 —
     짚은 자리가 곧 가려는 곳이라 손가락이 지나가는 대로 따라가면 된다. */
  const rail = sheet.querySelector("[data-cho-rail]");
  if (rail) {
    const body = sheet.querySelector(".sheet-body");
    const jump = y => {
      // 짚은 자리의 글자를 좌표로 찾는다 — 끌 때는 elementFromPoint 가 띠를 벗어난다
      const hit = [...rail.children].find(el => { const r = el.getBoundingClientRect();
        return y >= r.top && y <= r.bottom; });
      const k = hit?.dataset.k;
      if (!k) return;
      const head = list.querySelector(`[data-cho="${k}"]`);
      if (!head) return;                    // 그 칸에 아무도 없다
      body.scrollTop = headAt(body, head);
    };
    /* 짚고 있는지는 **우리가 적어 둔다.** hasPointerCapture 로 물으면 붙잡기에 실패한
       경우(브라우저나 기기에 따라 있다)에 손짓이 통째로 죽는다 — 붙잡기는 손가락이 띠를
       벗어나도 계속 받으려는 덤이지, 짚었는지를 가리는 근거가 아니다. */
    let held = false;
    rail.addEventListener("pointerdown", e => {
      held = true;
      try { rail.setPointerCapture(e.pointerId); } catch { /* 못 잡아도 짚는 데는 지장 없다 */ }
      rail.classList.add("on");
      jump(e.clientY);
      e.preventDefault();                   // 띠 위에서는 글자가 잡히지 않게
    });
    rail.addEventListener("pointermove", e => { if (held) jump(e.clientY); });
    const off = () => { held = false; rail.classList.remove("on"); };
    rail.addEventListener("pointerup", off);
    rail.addEventListener("pointercancel", off);
  }
  wireBar();

  /* 고르는 손짓은 **guard 를 거치지 않는다.**

     guard 는 서버를 기다리는 동안 두 번 눌리지 않게 막는 빗장인데, 여기서 하는 일은
     Set 에 넣고 빼는 것뿐이라 기다릴 것이 없다. 그런데도 씌워 두었더니 목록을 빠르게
     톡톡 짚을 때 **두 번째 손짓이 통째로 버려졌다** — 네모칸은 브라우저가 이미 켜 놓아
     체크는 보이는데 셈에는 안 들어가, 골랐다고 믿은 사람이 안 골린 채로 끊게 된다.

     고르는 중에는 네모칸이든 줄이든 같은 뜻이다 — 그때 열어 볼 일은 없다. */
  // 줄을 꾹 누르면 그 줄이 골라진 채로 고르기에 들어간다
  holdToPick(list, "[data-friend]", row => {
    if (!sel) { sel = new Set(); repaintBar(); }
    sel.add(row.dataset.friend);
    repaint(); repaintBulk();
  });

  list.addEventListener("click", e => {
    if (!sel) return;
    const pick = e.target.closest("[data-fpick]") ?? e.target.closest("[data-friend]");
    if (!pick) return;
    const id = pick.dataset.fpick ?? pick.dataset.friend;
    const on = !sel.has(id);
    on ? sel.add(id) : sel.delete(id);
    /* **그 줄의 네모칸만 고쳐 쓴다.** 목록을 통째로 다시 그리면 이백 명이 매번 새로
       그려지고, 무엇보다 지금 짚고 있는 줄이 그 자리에서 사라졌다 새로 생긴다 —
       손가락이 목록을 훑으며 톡톡 짚을 때 두 번째부터 헛손질이 된다.
       바뀌는 것은 네모 하나와 위의 셈뿐이다. */
    const box = pick.closest(".uf-row")?.querySelector("[data-fpick]");
    if (box) box.checked = on;
    repaintBulk();                       // 찾기 칸은 건드리지 않는다
  });

  list.addEventListener("click", guard(async e => {
    if (sel) return;                     // 고르는 중은 위에서 맡는다
    const st = e.target.closest("[data-star]");
    if (st) {
      const f = friends.find(x => x.id === st.dataset.star);
      f.starred = !f.starred;
      paintStar(st, f.starred);                     // 서버를 기다리지 않고 먼저 보여 준다
      /* 이 목록은 첫소리 차례라 별을 켜도 자리가 바뀌지 않는다. 그래도 다시 세워 두는
         것은 **다른 화면** 때문이다 — 폴더 바꾸기와 공개 대상 고르개는 별 켠 사람을
         위에 놓으므로, 여기서 켠 것이 그쪽에도 곧바로 반영되어야 한다. */
      sortFriends();
      if (onlyStar) repaint();                      // 즐겨찾기만 볼 때는 그 줄이 빠져야 한다
      try { await api("PATCH", `/api/friends/${f.id}`, { starred: f.starred }); }
      catch (err) { f.starred = !f.starred; paintStar(st, f.starred); throw err; }
      return;
    }
    const b = e.target.closest("[data-friend]");
    if (b) openFriendDetail(b.dataset.friend);
  }));

  sheet.querySelector("[data-invite]").onclick = guard(async () => {
    const inv = await api("POST", "/api/invites");
    openInviteMade(inv);
  });
}

function openInviteMade(inv) {
  const until = new Date(inv.expiresAt);
  openSheet(`
    ${headHtml("초대 링크", { actions: false,
      sub: `${until.getMonth() + 1}월 ${until.getDate()}일까지 쓸 수 있습니다.` })}
    <div class="field"><label>이 주소를 친구에게 보내세요</label>
      <textarea id="inv-url" readonly>${esc(inv.url)}</textarea></div>
    <div class="link-row">
      <button class="btn" data-copy>주소 복사</button>
      ${navigator.share ? `<button class="btn primary" data-share>공유하기</button>` : ""}
    </div>`);
  sheet.querySelector("[data-head-back]").onclick = openFriends;
  sheet.querySelector("[data-copy]").onclick = async () => {
    try { await navigator.clipboard.writeText(inv.url); toast("주소를 복사했습니다"); }
    catch { sheet.querySelector("#inv-url").select(); toast("복사가 막혀 있어 직접 선택했습니다"); }
  };
  const sh = sheet.querySelector("[data-share]");
  if (sh) sh.onclick = () => navigator.share({ title: "HabHobby 친구 초대", url: inv.url }).catch(() => {});
}

/** 친구 한 사람 — 폴더는 폴더 탭에서 보고, 여기서는 신원과 끊기만 다룬다.
    한때 이 화면이 공개 폴더를 통째로 한 벌 더 그렸는데, 같은 것을 두 곳에서 그리면
    한쪽만 고치는 일이 생긴다. */
function openFriendDetail(friendId) {
  const f = friends.find(x => x.id === friendId); if (!f) return;
  openSheet(`
    ${headHtml(esc(f.displayName), { actions: false, sub: f.sharedFolders
      ? `나에게 공개한 폴더 ${f.sharedFolders}개`
      : "나에게 공개한 폴더가 없습니다" })}
    ${f.sharedFolders
      ? `<button class="btn primary" style="width:100%" data-see>폴더 보러 가기</button>`
      : ""}
    <button class="btn" style="width:100%;margin-top:9px" data-unfriend>친구 끊기</button>`);

  sheet.querySelector("[data-head-back]").onclick = openFriends;
  const see = sheet.querySelector("[data-see]");
  if (see) see.onclick = guard(async () => {
    const d = await api("GET", `/api/friends/${friendId}/shared`);
    viewing = { id: d.friend.id, name: d.friend.displayName,
                folders: d.folders, works: d.works, platforms: d.platforms };
    closeSheet(); closeDrawer(); tab = "lib"; render();
  });
  sheet.querySelector("[data-unfriend]").onclick = guard(async () => {
    const yes = await askSure({
      title: "친구를 끊을까요?", ok: "친구 끊기", back: () => openFriendDetail(friendId),
      body: `${esc(f.displayName)}님과 서로의 공개 폴더가 보이지 않게 됩니다. 담아 둔 작품은 그대로 남습니다.`,
    });
    if (!yes) return;
    await api("DELETE", `/api/friends/${friendId}`);
    if (viewing?.id === friendId) viewing = null;      // 보고 있던 폴더를 계속 둘 수 없다
    await reload(); render(); openFriends();
  });
}

/* ── 앱 설정 ─────────────────────────────────────────────── */
const OPEN_MODES = [
  ["app", "기본 설정", "플랫폼 앱으로 엽니다. 앱이 설치돼 있지 않으면 웹으로 넘어갑니다."],
  ["web", "웹으로 열기", "언제나 브라우저에서 엽니다."],
];

function openAppSettings() {
  openSheet(`
    ${headHtml("설정", { back: false, actions: false })}
    ${colorPickerHtml(settings.themeColor, THEME_DEFAULT, "테마 색", "기본색")}
    ${/* 색 → 계정 → 여는 방식. 셋이 하는 일이 서로 다르므로 선으로 가른다 —
         한 덩이로 흘려 두면 어디까지가 한 이야기인지 짚어 가며 읽어야 한다.
         **계정이 위로 온다.** 「나는 누구로 보이나」는 이 창에서 가장 자주 보러 오는
         것이고, 여는 방식은 한 번 정하면 다시 안 건드린다. 자주 보는 것이 앞이다. */""}
    ${me ? `<div class="field sep"><label>계정</label>
      <div class="acct">
        ${me.avatar ? `<img class="acct-av" src="${esc(me.avatar)}" alt="">`
          : `<span class="acct-av ph">${guestMode() ? "👤"
              : esc((me.name || PROVIDER_LABEL[me.provider] || "?").slice(0, 1))}</span>`}
        <span class="acct-t">
          <b>${guestMode() ? "둘러보기" : esc(me.name || (PROVIDER_LABEL[me.provider] ?? "") + " 계정")}</b>
          <span>${guestMode() ? "이 기기에만 저장됩니다"
            : esc(PROVIDER_LABEL[me.provider] ?? me.provider) + (me.email ? " · " + esc(me.email) : "")}</span></span>
      </div>
      ${guestMode() ? `
      <div class="rest" style="text-align:left;padding:8px 2px 0">
        담아둔 것이 <b>이 기기에만</b> 있습니다. 쿠키가 지워지거나 기기를 바꾸면 되찾을 수 없고,
        친구 기능도 쓸 수 없습니다. <b>로그인하면 지금 담아둔 것이 그대로 옮겨집니다.</b></div>
      <div class="login-btns" style="margin-top:10px" data-guest-login></div>`
      : `
      <div class="name-row" style="margin-top:10px">
        <input id="set-dname" value="${esc(me.displayName ?? "")}"
               placeholder="표시 이름 (예: 영수)" maxlength="20">
        <button class="btn" data-save-name disabled>저장</button>
      </div>
      <div class="rest" style="text-align:left;padding:6px 2px 0">
        ${me.displayName
          ? "친구에게 이 이름으로 보입니다. 본명일 필요는 없습니다."
          : `<span style="color:var(--warn);font-weight:600">아직 정하지 않았습니다</span>` +
            " — 친구를 추가하려면 필요합니다."}
        ${/* 겹치는지는 저장할 때 서버가 본다. 규칙만 미리 적어 둔다 — 치는 동안 물어보면
             글자마다 서버를 두드리게 되고, 안내 한 줄에 그만한 값을 치를 이유가 없다. */""}
        다른 사람과 겹칠 수 없습니다.
      </div>`}
</div>` : ""}
    <div class="field sep"><label>작품을 여는 방식</label>
      ${optsHtml(OPEN_MODES, settings.openMode, "openmode", 2)}</div>
    ${me ? `<div class="field sep sep-end">
      <div class="link-row">
        ${me.provider === "local" || guestMode()
          ? `<button class="btn" disabled title="${guestMode()
              ? "둘러보기는 로그아웃하면 담아둔 것에 다시 닿을 수 없습니다"
              : "로그인이 설정되지 않았습니다"}">로그아웃</button>`
          : `<button class="btn" data-logout>로그아웃</button>`}
        <button class="btn bad" data-quit>${guestMode() ? "담아둔 것 모두 지우기" : "회원 탈퇴"}</button>
      </div>
      <div class="rest" style="text-align:left;padding:7px 2px 0">
        탈퇴하면 담아둔 작품·폴더·설정이 모두 지워지고 되돌릴 수 없습니다.</div>
    </div>` : ""}`);
  /* 스펙트럼을 끄는 동안 색이 계속 바뀐다 — 화면은 그때마다 따라가되
     저장은 손이 멎은 뒤 한 번만 한다. 시트는 다시 그리지 않는다 (고르개가 사라진다). */
  const themeDraft = { color: settings.themeColor };
  let themeTimer = null;
  wireColorPicker(sheet, themeDraft, THEME_DEFAULT, {
    onChange: () => {
      applyTheme(themeDraft.color);
      clearTimeout(themeTimer);
      themeTimer = setTimeout(async () => {
        try { await api("PUT", "/api/settings", { themeColor: themeDraft.color }); await reload(); render(); }
        catch (e) { toast(e.message); }
      }, 350);
    },
  });

  const gbox = sheet.querySelector("[data-guest-login]");
  if (gbox) api("GET", "/api/auth/providers").then(cfg => {
    if (!gbox.isConnected) return;
    gbox.innerHTML = cfg.providers.map(p => `<a class="login-btn" href="/auth/${p.id}"
      style="background:${p.color};color:${p.fg}">${esc(p.label)}</a>`).join("")
      || `<div class="rest" style="text-align:left">이 서버에는 로그인이 설정되어 있지 않습니다.</div>`;
  }).catch(() => {});

  wireOpts(sheet, "openmode", guard(async v => {
    await api("PUT", "/api/settings", { openMode: v });
    await reload(); openAppSettings();
  }), OPEN_MODES);

  /* 표시 이름 — 친구에게 보이는 유일한 신원이라 여기서도 고칠 수 있어야 한다.
     친구 추가하다 처음 정하는 것 말고는 손댈 길이 없었다. */
  const nameEl = sheet.querySelector("#set-dname");     // 둘러보기에는 없다
  const nameBtn = sheet.querySelector("[data-save-name]");
  if (nameEl && nameBtn) {
    const dirty = () => {
      const v = nameEl.value.trim();
      nameBtn.disabled = !v || v === (me.displayName ?? "");
    };
    nameEl.addEventListener("input", dirty);
    nameEl.addEventListener("keydown", e => { if (e.key === "Enter" && !nameBtn.disabled) nameBtn.click(); });
    nameBtn.onclick = guard(async () => {
      try {
        await api("PUT", "/api/me", { displayName: nameEl.value.trim() });
      } catch (e) {
        /* 겹치는 이름은 저장되지 않는다. 창을 다시 그리면 방금 친 이름이 날아가므로
           그대로 두고 알리기만 한다 — 한 글자만 고치면 되는 경우가 대부분이다. */
        toast(e.message);
        nameEl.focus(); nameEl.select();
        return;
      }
      await reload(); render();
      openAppSettings();                       // 안내 문구까지 새로 그린다
      toast("저장되었습니다");
    });
  }

  const out = sheet.querySelector("[data-logout]");
  if (out) out.onclick = guard(async () => {
    await api("POST", "/api/logout");
    // 남겨 두면 다음 사람이 로그인할 때 앞사람 색이 한 번 스친다
    try { localStorage.removeItem(THEME_CACHE); } catch {}
    location.href = "/";
  });
  const quit = sheet.querySelector("[data-quit]");
  if (quit) quit.onclick = guard(async () => {
    const yes = await askSure({
      title: "정말 탈퇴할까요?", ok: "탈퇴", back: openAppSettings,
      body: `담아 둔 ${works.length}편과 폴더 ${folders.length}개가 모두 지워집니다. 되돌릴 수 없습니다.`,
    });
    if (!yes) return;
    await api("DELETE", "/api/account");
    location.href = "/";
  });
}

/* ── 사이드 메뉴 ─────────────────────────────────────────── */
const drawerBack = document.getElementById("drawer-back");
const closeDrawer = () => {
  if (!drawerBack.hidden) lockScroll(false);
  drawerBack.hidden = true;
};

/* 화면이 넓으면 앱 카드 바깥에 여백이 생긴다. 검은 바탕은 카드 안에만 깔리므로
   (`.sheet-back` 은 `.app` 안의 absolute 다) 그 여백은 아무 데도 아니었는데, 눈에는
   검은 바탕과 똑같이 **창 밖**이다. 눌러도 같은 일이 일어나야 한다.

   앱 안쪽은 저마다의 손잡이가 맡으므로 건드리지 않는다. 사이드 메뉴가 시트 위에 있으므로
   (z-index 6 · 5) 열려 있으면 그쪽을 먼저 닫는다.

   **캡처 단계에서 본다.** 거품 단계까지 기다리면 그 사이에 시트가 다시 그려질 수 있는데,
   그러면 눌린 마디가 이미 떨어져 나가 `closest(".app")` 이 null 을 준다 — 앱 **안**을
   눌렀는데 밖을 누른 것으로 읽혀 창이 통째로 닫혔다. 캡처 때는 아직 붙어 있다. */
document.addEventListener("click", e => {
  if (e.target.closest(".app")) return;
  if (!drawerBack.hidden) return closeDrawer();
  if (!back.hidden) closeSheet();
}, true);
document.getElementById("btn-menu").onclick = () => {
  document.getElementById("drawer-stat").textContent =
    `작품 ${activeWorks().length} · 폴더 ${folders.length}`;
  for (const st of ["watched", "dropped"])
    document.querySelector(`[data-count="${st}"]`).textContent = worksInState(st).length;
  document.querySelector('[data-count="friends"]').textContent = friendCount;
  if (drawerBack.hidden) lockScroll(true);
  const dEl = drawerBack.querySelector(".drawer");
  dEl.style.transform = ""; dEl.style.transition = "";   // 지난번 드래그 자국이 남지 않게
  drawerBack.hidden = false;
};
drawerBack.addEventListener("click", e => { if (e.target === drawerBack) closeDrawer(); });
idleEl.onclick = openIdle;
fiEl.onclick = () => openFolderInvites();
document.getElementById("btn-bell").onclick = () => openBreakNotices();
// 메뉴 안의 종 — 메뉴를 닫고 연다. 창 두 겹이 겹쳐 서면 어느 것을 닫는지 헷갈린다.
document.getElementById("menu-bell").onclick = () => { closeDrawer(); openBreakNotices(); };
document.getElementById("menu-close").onclick = closeDrawer;   // 마우스가 있는 기기에만 보인다

/* 사이드 메뉴도 끌어 닫는다. 시트는 아래로, 이쪽은 **왼쪽으로** — 그래서 손잡이도
   가로 막대가 아니라 세로 막대다. 시트와 같은 규칙을 쓰되 축만 바꾼다. */
{
  const drawerEl = drawerBack.querySelector(".drawer");
  const CLOSE_AT = 90, SLOP = 8;
  let sx = 0, sy = 0, dx = 0, on = false, live = false;

  drawerEl.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    if (e.target.closest("input, textarea, select, [contenteditable]")) return;
    sx = e.clientX; sy = e.clientY; dx = 0; on = false; live = true;
  });

  drawerEl.addEventListener("pointermove", e => {
    if (!live) return;
    const gx = e.clientX - sx;
    if (!on) {
      if (Math.abs(e.clientY - sy) > Math.abs(gx)) { live = false; return; }  // 세로로 훑는 중
      if (gx > -SLOP) return;                                                 // 왼쪽으로만 닫힌다
      on = true;
      drawerEl.style.transition = "none";
      drawerEl.classList.add("dragging");
      try { drawerEl.setPointerCapture(e.pointerId); } catch {}
    }
    dx = Math.min(0, gx);
    drawerEl.style.transform = `translateX(${dx}px)`;
  });

  const end = () => {
    live = false;
    if (!on) return;
    on = false;
    const far = -dx > CLOSE_AT;
    drawerEl.classList.remove("dragging");
    drawerEl.style.transition = "transform .18s ease-out";
    if (far) {
      drawerEl.style.transform = `translateX(-${drawerEl.offsetWidth}px)`;
      setTimeout(() => {
        closeDrawer();
        drawerEl.style.transform = ""; drawerEl.style.transition = "";
      }, 170);
    } else {
      drawerEl.style.transform = "";
    }
  };
  drawerEl.addEventListener("pointerup", end);
  drawerEl.addEventListener("pointercancel", end);
}


document.getElementById("menu-friends").onclick = () => {
  if (guestMode()) { closeDrawer(); return openGuestWall(); }
  closeDrawer(); openFriends();
};

/* 게스트가 친구 자리를 눌렀을 때 — 막는 이유와 여는 길을 같이 알린다.
   그냥 버튼을 지우면 "왜 없지" 가 되고, 눌러도 아무 일이 없으면 고장으로 보인다. */
function openGuestWall() {
  openSheet(`
    ${headHtml("친구는 로그인이 필요합니다", { back: false, actions: false,
      sub: "지금은 <b>둘러보기</b>로 쓰고 있습니다." })}
    <div class="rest" style="text-align:left;padding:2px 2px 12px">
      둘러보기는 이 기기의 쿠키에만 매여 있습니다. 쿠키가 지워지거나 기기를 바꾸면
      담아둔 것에 다시 닿을 수 없어서, 남과 이어지는 기능은 열지 않습니다.<br><br>
      <b>지금 로그인해도 담아둔 것은 그대로 옮겨집니다.</b>
    </div>
    <div class="login-btns" data-guest-login></div>`);
  api("GET", "/api/auth/providers").then(cfg => {
    const box = sheet.querySelector("[data-guest-login]");
    if (!box) return;
    box.innerHTML = cfg.providers.map(p => `<a class="login-btn" href="/auth/${p.id}"
      style="background:${p.color};color:${p.fg}">${esc(p.label)}</a>`).join("")
      || `<div class="empty">이 서버에는 로그인이 설정되어 있지 않습니다.</div>`;
  }).catch(e => toast(e.message));
}
document.getElementById("menu-watched").onclick = () => { closeDrawer(); openArchive("watched"); };
document.getElementById("menu-dropped").onclick = () => { closeDrawer(); openArchive("dropped"); };
document.getElementById("menu-settings").onclick = () => { closeDrawer(); openAppSettings(); };
document.getElementById("btn-inbox").onclick = openInbox;

document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (!drawerBack.hidden) closeDrawer(); else closeSheet();
});

document.getElementById("btn-search").onclick = openFind;
document.getElementById("menu-search").onclick = () => { closeDrawer(); openFind(); };
/* 탭을 옮기는 것도 **하던 일을 그만두는 것**이다 — 폴더를 골라 둔 채 캘린더에 다녀오면,
   돌아왔을 때 무엇을 왜 골랐는지 기억나지 않는다. */
const goTab = t => { tab = t; folderSel = null; render(); };
document.getElementById("tab-cal").onclick = () => goTab("cal");
document.getElementById("tab-home").onclick = () => goTab("home");
document.getElementById("tab-lib").onclick = () => { closeSheet(); goTab("lib"); };

/* 폴더 줄도 꾹 누르면 고르기로 들어간다 — 친구 목록과 같은 손짓이다.
   🗂 전체와 🫙 미분류는 진짜 폴더가 아니라 고를 것이 없다. */
holdToPick(screenEl, ".folder[data-folder]", row => {
  const id = row.dataset.folder;
  if (tab !== "lib" || viewing || !folders.some(f => f.id === id)) return;
  if (!folderSel) folderSel = new Set();
  folderSel.add(id);
  render();
});

screenEl.addEventListener("click", e => {
  if (e.target.closest("[data-idle]")) return openIdle();
  const cv = e.target.closest("[data-calview]");
  if (cv) {
    calView = cv.dataset.calview;
    // 월간을 열면 오늘이 눌린 채로 — 오늘 볼 것부터 보이는 게 맞다
    if (calView === "month") { calMonth = null; calDay = midnight().getTime(); }
    return render();
  }
  const mv = e.target.closest("[data-cal-move]");
  if (mv) return moveMonth(Number(mv.dataset.calMove));
  if (e.target.closest("[data-cal-today]")) { calMonth = null; calDay = null; return render(); }
  if (e.target.closest("[data-cal-close]")) { calDay = null; return render(); }
  const cd = e.target.closest("[data-cal-day]");
  if (cd) {
    const t = Number(cd.dataset.calDay);
    calDay = calDay === t ? null : t;   // 고른 날을 다시 누르면 접힌다
    return render();
  }

  if (e.target.closest("[data-soon-all]")) return openSoon();
  const da = e.target.closest("[data-day-all]");
  if (da) return openDayList(Number(da.dataset.dayAll));
  const all = e.target.closest("[data-plat-all]");
  if (all) return openPlatformList(all.dataset.platAll);
  const plat = e.target.closest("[data-plat]");
  if (plat) return openPlatformEdit(plat.dataset.plat);
  const w = e.target.closest(".work, .row"); if (w) return openWork(w.dataset.id);
  /* 갈래 고르개도 .chip 이다 — **매체 거르개보다 먼저** 봐야 한다.
     아래가 먼저 잡으면 dataset.filter 가 없어 filter 가 undefined 가 되고,
     갈래는 갈래대로 안 바뀌면서 목록만 통째로 비어 보인다. */
  const k = e.target.closest("[data-fkind]");
  if (k) { fkind = k.dataset.fkind; return render(); }
  const c = e.target.closest("[data-filter]"); if (c) { filter = c.dataset.filter; return render(); }
  /* 별을 켜면 그 폴더가 목록 맨 위로 온다(kindShown). 줄이 자리를 옮기므로 그 자리에서
     칠하는 것으로는 모자라고 목록을 다시 세워야 한다 — 서버는 기다리지 않는다. */
  const fs2 = e.target.closest("[data-fstar]");
  if (fs2) {
    const f = folders.find(x => x.id === fs2.dataset.fstar);
    if (!f) return;
    flipStar(f);
    render();
    return api("PUT", `/api/folders/${f.id}/star`, { starred: f.starred })
      .catch(err => { flipStar(f); render(); toast(err.message); });
  }
  if (e.target.closest("[data-fav-list]")) return openFavFolders();
  const fe = e.target.closest("[data-folder-edit]");
  if (fe) return openFolderForm(folders.find(x => x.id === fe.dataset.folderEdit),
    () => { closeSheet(); render(); });
  // 누구의 폴더를 볼 것인가
  if (e.target.closest("[data-whose]")) return openWhose();
  if (e.target.closest("[data-mine]")) { viewing = null; return render(); }
  const ff = e.target.closest("[data-fr-folder]");
  if (ff) return openFriendFolder(ff.dataset.frFolder);

  // 여러 개 고르기 — 켜고, 끄고, 전부 고르고, 지운다
  if (e.target.closest("[data-fsel]")) { folderSel = new Set(); return render(); }
  if (e.target.closest("[data-fsel-off]")) { folderSel = null; return render(); }
  if (e.target.closest("[data-fsel-all]")) {
    // 갈래로 좁혀 놓았으면 보이는 것만 집는다 — 안 보이는 폴더가 함께 지워지면 안 된다
    const vis = kindShown();
    folderSel = new Set(vis.every(x => folderSel.has(x.id)) ? [] : vis.map(x => x.id));
    return render();
  }
  if (e.target.closest("[data-fsel-del]")) return deleteFolders();

  /* 네모칸이든 줄이든 같은 뜻이다 — 고르는 중에 폴더를 열 일은 없다.
     네모칸을 직접 누른 것은 브라우저가 이미 켜고 껐으므로 값만 맞춰 다시 그린다. */
  const pick = e.target.closest("[data-fpick]") ?? (folderSel ? e.target.closest("[data-folder]") : null);
  if (pick) {
    const id = pick.dataset.fpick ?? pick.dataset.folder;
    if (folders.some(x => x.id === id)) {         // 전체·미분류는 고를 수 없다
      folderSel.has(id) ? folderSel.delete(id) : folderSel.add(id);
      return render();
    }
    return;
  }

  const f = e.target.closest("[data-folder]");
  if (f) { filter = "all"; return openFolderSheet(f.dataset.folder); }
  if (e.target.closest("[data-new-folder]"))
    return openFolderForm(null, f2 => {
      closeSheet(); render();
      if (f2) { filter = "all"; openFolderSheet(f2.id); }   // 만들자마자 열어 준다
    });
});

/* ── 로그인 ──────────────────────────────────────────────── */
function showLogin(providers, errMsg) {
  let mode = "login";                      // login | signup

  const draw = (msg) => {
    const 가입 = mode === "signup";
    document.querySelector(".app").innerHTML = `
    <div class="login">
      <div class="login-brand">Hab<span>Hobby</span></div>
      <p class="login-lead">흩어진 미디어 생활을 하나의 목록으로.<br>
        웹툰·드라마·영화, 어디서 보든 한 곳에서 이어 보세요.</p>
      ${msg ? `<div class="note">${esc(msg)}</div>` : ""}

      <form class="login-form" id="pw-form" autocomplete="on">
        <div class="pickers" id="pw-mode">
          <button class="pick" type="button" data-m="login" aria-pressed="${!가입}">로그인</button>
          <button class="pick" type="button" data-m="signup" aria-pressed="${가입}">가입하기</button>
        </div>
        <input id="pw-id" name="username" placeholder="아이디 (영문·숫자 3~20자)"
               autocomplete="username" spellcheck="false" maxlength="20">
        <input id="pw-pw" name="password" type="password" placeholder="비밀번호 (8자 이상)"
               autocomplete="${가입 ? "new-password" : "current-password"}" maxlength="200">
        <button class="login-btn solid" type="submit">${가입 ? "가입하고 시작하기" : "로그인"}</button>
        ${가입 ? `<p class="login-foot" style="margin:6px 0 0">
          비밀번호를 잊으면 되찾을 길이 없습니다 — 메일 인증을 두지 않았습니다.</p>` : ""}
      </form>

      ${providers.length ? `<div class="login-or">또는</div>` : ""}
      <div class="login-btns">
        ${providers.map(p => `<a class="login-btn" href="/auth/${p.id}"
          style="background:${p.color};color:${p.fg}">${esc(p.label)}</a>`).join("")}
        <button class="login-btn ghost" id="go-guest">로그인 없이 둘러보기</button>
      </div>
      <p class="login-foot">로그인하면 담아둔 목록이 기기와 상관없이 따라옵니다.<br>
        <b>둘러보기</b>는 이 기기에만 남고 친구 기능을 쓸 수 없습니다 —
        나중에 로그인하면 담아둔 것이 그대로 옮겨집니다.</p>
    </div>`;

    document.getElementById("pw-mode").onclick = e => {
      const b = e.target.closest("[data-m]"); if (!b) return;
      mode = b.dataset.m;
      const id = document.getElementById("pw-id").value;
      draw();                              // 갈래가 바뀌면 안내 문구도 바뀐다
      document.getElementById("pw-id").value = id;
    };

    document.getElementById("pw-form").onsubmit = guard(async e => {
      e.preventDefault();
      const loginId = document.getElementById("pw-id").value.trim();
      const password = document.getElementById("pw-pw").value;
      try {
        await api("POST", `/auth/password/${mode}`, { loginId, password });
      } catch (err) { draw(err.message); return; }
      location.replace("/");               // 쿠키를 들고 처음부터 다시
    });

    document.getElementById("go-guest").onclick = guard(async () => {
      await api("POST", "/auth/guest");
      location.replace("/");
    });
  };

  draw(errMsg);
}

/* ── 부팅 ────────────────────────────────────────────────── */
/* 초대 링크(`/?invite=코드`)로 들어왔는데 아직 로그인 전일 수 있다.
   가입·로그인을 거치면 주소가 "/" 로 바뀌어 초대 코드가 사라지므로, 창이 살아 있는 동안
   따로 적어 둔다. sessionStorage 는 그 탭에만 있고 카카오에 다녀와도 남는다. */
const INVITE_KEY = "hh-invite";
const keepInvite = code => { try { sessionStorage.setItem(INVITE_KEY, code); } catch { /* 막힌 곳 */ } };
const takeInvite = () => {
  try {
    const v = sessionStorage.getItem(INVITE_KEY);
    sessionStorage.removeItem(INVITE_KEY);
    return v;
  } catch { return null; }
};

(async function boot() {
  const q0 = new URLSearchParams(location.search);
  const loginError = q0.get("login_error");
  if (loginError) history.replaceState(null, "", location.pathname);
  // 로그인 화면으로 빠지기 **전에** 적어 둔다 — 그 뒤로는 주소에 남지 않는다
  if (q0.get("invite")) keepInvite(q0.get("invite"));

  try {
    await reload(true);          // 앱을 새로 여는 길 — 읽어 둔 소식을 걷고 시작한다
  } catch (e) {
    /* 로그인이 필요하면 제공자 목록을 받아 로그인 화면을 띄운다.

       **이 물음이 답을 받았다는 것 자체가 서버가 살아 있다는 뜻**이다(이 길은 로그인
       없이도 열려 있다). 그러니 여기까지 왔으면 「연결이 안 된다」가 아니라 「로그인이
       필요하다」이고, 로그인 화면을 세우는 것이 맞다.

       한때 조건이 "OAuth 버튼이 하나라도 있으면" 이었다. 그런데 로그인 화면에는 버튼
       말고도 **아이디 로그인과 둘러보기**가 있어서, 버튼을 다 꺼 두면 멀쩡히 로그인할
       수 있는데도 「서버에 연결하지 못했습니다」가 떴다. */
    try {
      const cfg = await api("GET", "/api/auth/providers");
      showLogin(cfg.providers, loginError); return;
    } catch { /* 서버 자체가 죽은 경우 — 아래로 내려간다 */ }
    screenEl.innerHTML = `<div class="empty">서버에 연결하지 못했습니다.<br>${esc(e.message)}</div>`;
    return;
  }
  if (loginError) setTimeout(() => toast(loginError), 300);
  readHash();          // folders가 채워진 뒤라야 폴더 검증이 된다
  const wasOpen = openFolderId;   // 새로 고치기 전에 열어 두었던 폴더
  openFolderId = null;
  render();
  if (wasOpen) openFolderSheet(wasOpen);
  fillSiteNames();     // 화면을 막지 않는다 — 이름은 늦게 와도 된다

  // 주소를 직접 고치거나 뒤로 가기로 해시가 바뀐 경우
  addEventListener("hashchange", () => {
    readHash();
    const want = openFolderId;
    openFolderId = null;
    render();
    if (want) openFolderSheet(want); else closeSheet();
  });

  // 초대 링크로 들어온 경우 — 주소에 있든, 로그인 전에 적어 둔 것이든
  const invite = takeInvite();
  if (invite) {
    history.replaceState(null, "", location.pathname + location.hash);
    try {
      const d = await api("GET", `/api/invites/${invite}`);
      if (d.me) toast("내가 만든 초대 링크입니다.");
      else if (d.already) toast(`${d.from.displayName}님과 이미 친구입니다.`);
      else openInviteAccept(invite, d.from);
    } catch (e) { toast(e.message); }
    return;
  }

  // 공유 대상으로 들어온 경우 — 주소를 들고 바로 추가 화면을 연다
  const q = new URLSearchParams(location.search);
  const shared = q.get("url") || q.get("text") || "";
  if (shared) {
    history.replaceState(null, "", location.pathname + location.hash);
    const m = shared.match(/https?:\/\/\S+/);
    openAdd(m ? m[0] : shared.trim(), true);
  }

  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
