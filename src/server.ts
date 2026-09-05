/* HTTP 서버 — 의존성 없이 node:http만 쓴다.
   API + 정적 파일 + PWA 공유 대상(share target)을 한 프로세스가 담당한다. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { copyFile, readFile, stat, writeFile, unlink } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, normalize, resolve as pathResolve } from "node:path";
import {
  db, kvGet, kvSet, listWorks, getWork, setWorkFolders, listFolders, newId, sitesFor, setSite, forgetSite,
  deleteUser, upsertUser, listFriends, countFriends, starFriend, contributedWorks,
  addFriend, removeFriend, areFriends,
  createGuest, linkGuest, isGuest,
  createPasswordUser, passwordUser, linkGuestPassword, markLogin,
  sharedView, createInvite, inviteOwner, getUser, setFolderShare, setFolderTake,
  getFolder, createFolder, canCopy, canMirror, canEdit, seenByMe, markSeen,
  folderInvites, acceptFolder, declineFolder, leaveFolder,
  noticeBreak, folderNotices, readNotices, sweepNotices, inviteToFolder, unlinkFromFolder,
  cleanName, setDisplayName, starFolder, findOrMakeUrl, findKeptWork, knownUrl,
  staleCovers, refreshCover, markChecked,
  listArchFolders, createArchFolder, renameArchFolder, deleteArchFolder, setArchFolder,
  type Work, type User, type ShareMode, type TakeMode,
} from "./db.ts";
import {
  PROVIDERS, configuredProviders, availableProviders, startLogin, completeLogin, createSession,
  userFromToken, destroySession, cookieHeader, readCookie, COOKIE,
  shareKeyUser, createShareKey, listShareKeys, deleteShareKey,
  localFallbackAllowed, redirectUri, BASE_URL,
  hashPassword, verifyPassword, validLoginId, validPassword,
} from "./auth.ts";
import { PLATFORMS, platformById, readableOn, DOMAIN_PREFIX, registrableDomain } from "./platforms.ts";
import { resolveUrl, originLabel, fetchSiteName, type Resolved } from "./resolve.ts";

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC = pathResolve(process.cwd(), "public");

/* 직접 올린 표지를 두는 곳. 아이폰 사파리에는 "이미지 주소 복사" 가 없어서 주소만으로는
   길이 막힌다 — 사진을 그대로 올릴 수 있어야 한다.
   data/ 아래에 두는 이유는 그 폴더만 바깥에 매어 두면(도커 bind mount) 되기 때문이다. */
const COVERS = pathResolve(process.cwd(), process.env.DATA_DIR ?? "data", "covers");
mkdirSync(COVERS, { recursive: true });
/* 화면에서 긴 변 400px 로 줄여 보내므로 한 장이 30~50KB 다. 1MB 는 그것이 어긋났을 때를
   막는 빗장이지 실제로 닿는 값이 아니다. */
const COVER_MAX = 1024 * 1024;

/* ── 응답 헬퍼 ────────────────────────────────────────────── */
const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
};

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("요청 본문이 너무 큽니다.");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("JSON을 읽을 수 없습니다."); }
}

/* ── 설정과 플랫폼 표시 오버라이드 ─────────────────────────── */
/** 보관한 작품을 **어느 탭에 함께 세우나.** 탭 열쇠들의 부분집합이다.

    켜고 끄는 것이 셋이라 갈래(enum)로 만들 수도 있었지만, 사람이 고르는 것은
    「어디에」 하나다 — 한 칸에 담아 두면 탭이 늘어도 이 자리는 그대로다. */
const DONE_TABS = ["all", "cal", "home", "lib"];
type Settings = { openMode: "app" | "web"; themeColor: string | null; doneIn: string[] };
type Override = { name?: string; initial?: string; color?: string; fg?: string };
/* 마크 글자색은 배경에 맞춰 저절로 정해지지만, 경계에 걸친 색에서는 사람 눈에
   반대쪽이 나을 때가 있다 — 그래서 흰색·검정 둘 중에 직접 고를 수도 있다. */
const FG_CHOICES = ["#FFFFFF", "#1B1B1B"];
const normFg = (v: unknown): string | undefined => {
  const u = typeof v === "string" ? v.toUpperCase() : "";
  return FG_CHOICES.includes(u) ? u : undefined;
};

/** 기본값은 **페이지와 폴더**다. 다 본 작품이 목록에서 통째로 사라지는 것보다,
    배지를 달고 제자리에 서 있는 편이 처음 보는 사람에게 덜 놀랍다 — 「어디 갔지」를
    묻게 하지 않는다. 캘린더만 빼 둔다: 거기는 앞으로 볼 것을 챙기는 자리라,
    끝난 작품이 매주 다시 서면 오늘 할 일이 묻힌다.

    손수 껐던 사람은 그대로다. 저장된 값이 이 기본값을 덮으므로, 빈 배열을 적어 둔
    사람에게 빈 배열이 남는다 — 기본값을 고쳤다고 남의 결정이 되살아나지 않는다. */
const getSettings = (u: string): Settings =>
  ({ openMode: "app", themeColor: null, doneIn: ["all", "home", "lib"],
     ...kvGet<Partial<Settings>>(u, "settings", {}) });
const getOverrides = (u: string): Record<string, Override> => kvGet<Record<string, Override>>(u, "overrides", {});
/* 사이트가 스스로 밝힌 이름(og:site_name). 빈 문자열은 "받아봤지만 없더라"는 표시다 —
   키가 있으면 다시 묻지 않으므로 실패한 사이트를 접속할 때마다 두드리지 않는다. */
/* 사용자가 "이 둘은 같은 곳"이라고 정해 준 도메인들. 자동 규칙이 못 맞히는 경우
   (product.kyobobook.co.kr 과 search.kyobobook.co.kr 처럼) 한 번 정하면 계속 따른다. */
const getMerges = (u: string): Record<string, string> => kvGet<Record<string, string>>(u, "domainMerges", {});
/* "이 도메인 아래는 전부 여기로" — 등록 단위를 열쇠로 삼는다.
   kyobobook.co.kr → domain:product.kyobobook.co.kr 이면 event·search 도 따라간다. */
const getWild = (u: string): Record<string, string> => kvGet<Record<string, string>>(u, "domainMergeWild", {});

/** 저장할 구간을 고른다. 짝으로 정한 것이 먼저고, 없으면 도메인 규칙을 본다.
    짝이 자기 자신을 가리키면 "여기 못 박음" 이라는 뜻이라 도메인 규칙을 건너뛴다. */
function applyMerge(u: string, id: string): string {
  const m = getMerges(u);
  if (id in m) return m[id];
  if (!id.startsWith(DOMAIN_PREFIX)) return id;
  return getWild(u)[registrableDomain(id.slice(DOMAIN_PREFIX.length))] ?? id;
}

/** 그 구간에 실제로 담겨 있는 호스트들 — 작품의 주소에서 읽는다 */
/** 구간 하나를 그리는 데 필요한, **사람마다 한 번이면 되는** 값들.

    앱을 열면 구간이 열일곱 가지쯤 온다. 그 하나하나가 제 손으로 덮어쓴 값(overrides)과
    사이트 이름(siteNames)을 다시 읽고 호스트를 다시 셌다 — 같은 값을 열일곱 번 읽고
    열일곱 번 파싱한 셈이라 요청 하나에 질의가 서른 번 넘게 늘었다. 한 번 모아 돌려 쓴다. */
type PlatCtx = {
  ov: Record<string, Override>;
  /** 사이트가 밝힌 이름 — 구간 id → 이름. 읽었는데 없으면 '' */
  auto: Record<string, string>;
  /** 사이트 표 — 구간 id → 절대 주소 */
  icons: Record<string, string>;
  hosts: Map<string, string[]>;
};

/** 이 구간이 어느 사이트인가 — **대표 호스트**.

    도메인 구간은 id 에서 잘라내면 되지만 내장 플랫폼은 그렇지 않다(naver-blog →
    blog.naver.com). 둘 다 hosts[0] 이 그 사이트다 — domainPlatform 도 hosts: [host] 로
    짓는다. 이 하나로 가르면 「도메인이냐 내장이냐」를 묻는 자리가 없어진다.
    「직접 입력」(note)만 호스트가 없다 — 물어볼 사이트가 없는 구간이다. */
const hostOf = (id: string): string | null => platformById(id).hosts[0] ?? null;

function platformCtx(userId: string): PlatCtx {
  /* 구간은 내 분류(work), 주소는 공용(url) — 나뉘어 있으므로 이어 붙여 읽는다. */
  const rows = db.prepare(`SELECT w.platform_id, u.list_url
    FROM work w JOIN url u ON u.id = w.url_id WHERE w.user_id = ?`)
    .all(userId) as { platform_id: string; list_url: string }[];
  const sets = new Map<string, Set<string>>();
  for (const r of rows) {
    try {
      const h = new URL(r.list_url).hostname.replace(/^www./, "").replace(/^m./, "");
      let set = sets.get(r.platform_id);
      if (!set) sets.set(r.platform_id, set = new Set());
      set.add(h);
    } catch { /* 읽을 수 없는 주소는 셈에서 뺀다 */ }
  }
  const hosts = new Map<string, string[]>();
  for (const [k, v] of sets) hosts.set(k, [...v].sort());
  /* 사이트가 밝힌 이름·표는 **공용 site 표**에서 — 한때 사람마다 kv 에 따로 적었다.
     이 사람이 담은 구간의 대표 호스트를 한 번에 읽는다.

     **내장 플랫폼도 함께 읽는다.** 표(favicon)는 도메인 구간만의 이야기가 아니다 —
     네이버 블로그도 제 표를 밝혀 두었고, 글자 하나보다 그것이 빨리 읽힌다.
     이름은 다르다: 내장 플랫폼의 이름은 우리가 고른 것이라 사이트에 묻지 않는다. */
  const byHost = new Map<string, string>();          // 호스트 → 구간 id
  for (const k of sets.keys()) { const h = hostOf(k); if (h) byHost.set(h, k); }
  const sites = sitesFor([...byHost.keys()]);
  const auto: Record<string, string> = {}, icons: Record<string, string> = {};
  for (const [h, k] of byHost) {
    const s = sites.get(h);
    if (!s) continue;
    if (k.startsWith(DOMAIN_PREFIX)) auto[k] = s.name;
    if (s.icon) icons[k] = s.icon;
  }
  return { ov: getOverrides(userId), auto, icons, hosts };
}

const firstChar = (s: string) => [...s][0] ?? "?";

/** 내장 플랫폼과 도메인 플랫폼을 같은 방식으로 다룬다 — 표시 설정은 둘 다 바꿀 수 있다. */
function platformView(userId: string, id: string, ctx: PlatCtx = platformCtx(userId)) {
  const base = platformById(id);
  const o = ctx.ov[id];
  const isDomain = base.id.startsWith(DOMAIN_PREFIX);
  // 사이트가 밝힌 이름은 주소보다 낫지만, 사용자가 직접 지은 이름보다는 아래다
  const auto = isDomain ? ctx.auto[id] || null : null;
  const color = o?.color ?? base.color;
  return {
    id: base.id,
    name: o?.name ?? auto ?? base.name,
    initial: o?.initial ?? (auto ? firstChar(auto) : base.initial),
    /* 사이트 표 — 「사이트가 밝힌 것」 층이다. 글자 마크를 손수 정했으면 그것이 이긴다:
       내가 고른 마크 위에 사이트 그림을 덮으면 고른 뜻이 없다.

       **내장 플랫폼도 마찬가지다.** 한때 도메인 구간에만 붙였는데, 그건 「우리가 고른
       마크가 파비콘보다 낫다」는 가정이었다 — 실제로는 진짜 표가 나은 쪽이 더 많았다.

       손수 정한 마크(o.initial)가 있으면 그것이 이기지만, 표가 있는 구간에서는 화면이
       마크 칸을 세우지 않으므로(openPlatformEdit) 새로 정할 길은 없다. 표를 밝힌
       사이트는 그 표로 서는 것이 규칙이다. */
    icon: !o?.initial ? ctx.icons[id] ?? null : null,
    color,
    // 직접 고른 것이 없으면 배경에서 계산한다
    fg: o?.fg ?? readableOn(color),
    fgSet: !!o?.fg,
    mediaType: base.mediaType,
    isDomain,
    host: isDomain ? base.id.slice(DOMAIN_PREFIX.length) : null,
    // 화면이 "이 도메인 아래 전부"와 "분리" 를 그리는 데 쓴다
    domainBase: isDomain ? registrableDomain(base.id.slice(DOMAIN_PREFIX.length)) : null,
    hosts: isDomain ? ctx.hosts.get(base.id) ?? [] : [],
    overridden: !!o,
    // 되돌리기의 기준도 사이트가 밝힌 이름이다 — 주소로 돌아가는 건 후퇴다
    baseName: auto ?? base.name,
    baseInitial: auto ? firstChar(auto) : base.initial,
    baseColor: base.color,
    baseFg: readableOn(color),
  };
}

/** 구간 여럿을 한꺼번에. 모으기는 한 번뿐이다. */
const platformViews = (userId: string, ids: Iterable<string>) => {
  const ctx = platformCtx(userId);
  return Object.fromEntries([...ids].map(id => [id, platformView(userId, id, ctx)]));
};

/** 아직 사이트 이름을 물어보지 않은 도메인들 */
/** 아직 사이트에 물어보지 않은 구간 — 도메인이든 내장 플랫폼이든.

    이름은 도메인 구간만 쓰지만 **표는 둘 다 쓴다.** 물어보는 일이 같으므로 한 자리에서
    센다. 「직접 입력」처럼 호스트가 없는 구간은 물어볼 곳이 없어 빠진다. */
function pendingSiteNames(userId: string): { id: string; host: string }[] {
  const ids = [...new Set(listWorks(userId).map(w => w.platformId))];
  const pairs = ids.map(id => ({ id, host: hostOf(id) }))
    .filter((x): x is { id: string; host: string } => !!x.host);
  const known = sitesFor(pairs.map(x => x.host));
  return pairs.filter(x => !known.has(x.host));
}

/** 클라이언트가 보낸 일정을 저장 가능한 모양으로 맞춘다.
    빠진 칸이 있으면 SQLite 바인딩에서 죽으므로 여기서 막는다. */
function normSchedule(v: any) {
  const s = v ?? {};
  const mode = typeof s.mode === "string" ? s.mode : "unknown";
  let days: number[] = Array.isArray(s.days)
    ? s.days.filter((n: any) => Number.isInteger(n)) : [];
  let next = typeof s.next === "number" ? s.next : null;

  /* **날짜 지정은 days 에 날짜들을 담는다.** 그 칸은 「이 일정이 쓰는 숫자들」이라
     매주는 요일(0~6), 매월은 날짜(1~31)를 담아 왔다 — 날짜 지정은 날짜를 담는다.
     칸을 새로 내지 않은 것은, 담기·고치기·이관·바뀜 판정이 이미 이 칸을 지나기
     때문이다: 칸을 늘리면 그 다섯 자리를 모두 손봐야 하고 하나만 빠뜨려도 조용히 샌다.

     next 는 여기서 **다시 적는다**. 화면이 무엇을 보냈든 「다가오는 가장 가까운 날」이
     되도록 — 캘린더의 「예정」이 그 값으로 고르고 차례를 매긴다(upcoming). 다 지났으면
     마지막 날을 둔다: 그러면 예정에는 안 서고(오늘보다 이르다) 목록에는 남은 사실이 적힌다.

     옛 줄도 받아 준다 — days 가 비고 next 만 있으면 그 하루를 날짜 목록으로 삼는다. */
  if (mode === "dated") {
    if (!days.length && next) days = [next];
    days = [...new Set(days)].sort((a, b) => a - b);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    next = days.find(t => t >= today.getTime()) ?? days[days.length - 1] ?? null;
  }
  return { mode, days, next, source: s.source === "auto" ? "auto" : "user" };
}

/* ── 미러링 ───────────────────────────────────────────────
   비추는 폴더는 **작품을 담고 있지 않다.** 화면을 그릴 때마다 주인 것을 그대로 가져다
   내 폴더 안에 놓아 준다. 그래서 주인이 고치면 나에게도 바뀌고, 나는 고칠 수 없다.

   담아가기와 갈리는 자리가 여기다 — 담아간 것은 내 표에 한 벌이 생기지만,
   비추는 것은 내 표에 **폴더 한 줄**만 있고 작품은 늘 남의 것이다. */

/** 내 폴더 목록과 작품 목록에 비추는 것들을 섞어 넣는다. */
function withMirrors(me: string): { folders: any[]; works: any[] } {
  const folders = listFolders(me);
  const works: any[] = listWorks(me);

  /* 남의 작품을 **내가** 어떻게 보고 있는지. 붉은 점과 차례를 정하는 값이라 미리 읽어 둔다. */
  const seen = seenByMe(me);
  /* 이미 내가 담아 둔 작품인지 가리는 열쇠 — 같은 곳의 같은 시리즈면 같은 작품이다. */
  const keyOf = (w: any) => `${w.platformId}\u0000${w.seriesId}`;
  /* **살아 있는 것만 담는다.** 휴지통이나 보관에 내려둔 작품이 여기 끼어 있으면,
     그것이 친구 줄을 밀어내 놓고 저는 화면에서 걸러진다(폴더는 active 만 세운다) —
     친구 폴더에는 멀쩡히 있는데 내 쪽에서만 조용히 사라지는 구멍이 난다.

     못 본 척하는 것이 옳다: 내가 내 목록에서 내려둔 것은 **내 목록의 결정**이지,
     친구 폴더를 어떻게 볼지의 결정이 아니다. 되돌리면 다시 여기 들어와 제자리를 찾는다. */
  /* **휴지통만 뺀다.** 한때 살아 있는 것만 보았는데, 그러면 내가 보관한 작품이
     친구 폴더에 있을 때 친구 줄이 한 장 더 서서 같은 작품이 두 장 보였다.
     들고 있는 것은 들고 있는 것이다 — 내 줄이 그 자리에 선다(배지가 붙는다).

     보관을 폴더에 안 세우기로 했다면 그 자리는 비어 보인다. 그건 구멍이 아니라
     **내가 켜고 끈 것**이다 — 전체 설정이 그렇게 말하고 있다. */
  const mineByKey = new Map<string, any>(
    works.filter(w => w.state !== "dropped").map(w => [keyOf(w), w]));

  /** 남의 작품 한 줄을 내 목록에 놓을 모양으로 바꾼다 */
  const asGuest = (w: any, folderId: string, owner: string, who: string,
                   take: string, folderOnly: boolean) => {
    const mark = seen.get(w.id);
    // 상태는 이미 떼어져 온다 (db 의 asShared) — 남의 완료는 남의 일이다
    /* **남의 보관 폴더는 비운다.** 보관 폴더는 나만 보는 갈래라, 남의 줄을 비쳐 오면서
       그 사람의 폴더 id 까지 실어 오면 안 된다 — 화면에 이름이 뜨지는 않아도 내보낼
       까닭이 없는 값이다. 상태를 떼어 오는 것(asShared)과 같은 결이다. */
    return { ...w, folders: [folderId], filed: true, archFolder: null,
      /* 눌러 봤으면 붉은 점을 끄고, 보러 갔으면 그때를 차례로 쓴다. 한 번도 안 갔으면
         담긴 때 — 친구가 여는 것에 내 목록이 흔들리지 않게. */
      visits: mark?.seen ? 1 : 0,
      lastAt: mark?.opened ?? w.addedAt,
      mirror: owner, mirrorOf: who, mirrorTake: take, folderOnly };
  };

  /* 내가 주인인 **함께 고치는 폴더**에는 친구들이 넣은 작품도 들어 있다.
     내 표에는 없으므로 따로 모아 온다 — 남의 것이라 고칠 수 없고 달력에도 올리지 않는다. */
  for (const f of folders.filter(x => !x.mirror && canEdit(x.take))) {
    for (const w of contributedWorks(f.id, { not: me })) {
      // 내가 이미 담아 둔 것이면 내 것이 이긴다 — 비추는 폴더와 같은 규칙이다
      const mine = mineByKey.get(keyOf(w));
      if (mine) { if (!mine.folders.includes(f.id)) mine.folders = [...mine.folders, f.id]; continue; }
      works.push(asGuest(w, f.id, w.owner, w.ownerName, f.take, true));
    }
  }

  if (!folders.some(f => f.mirror)) return { folders, works };

  /* 한 친구의 폴더를 여럿 비추고 있으면 그 사람 것은 **한 번만** 읽는다 —
     폴더마다 읽으면 같은 질의를 몇 번씩 되풀이한다. */
  const views = new Map<string, ReturnType<typeof sharedView> | null>();
  const viewOf = (owner: string) => {
    if (!views.has(owner)) views.set(owner, areFriends(me, owner) ? sharedView(owner, me) : null);
    return views.get(owner)!;
  };
  const names = new Map<string, string>();
  const nameOf = (id: string) => {
    if (!names.has(id)) names.set(id, getUser(id)?.displayName ?? "이름 없음");
    return names.get(id)!;
  };
  /* 한 작품이 비추는 폴더 둘에 다 들어 있을 수 있다. 그때 두 번 밀어 넣으면 같은 번호를
     가진 줄이 둘이 되어 「전체」와 캘린더에 겹쳐 보인다 — 한 줄만 두고 폴더만 보탠다. */
  const placed = new Map<string, any>();

  const out = folders.map(f => {
    if (!f.mirror) return f;
    const who = nameOf(f.mirror.owner);
    const view = viewOf(f.mirror.owner);
    const src = view?.folders.find(x => x.id === f.mirror!.folder);
    /* 원본이 사라져도 폴더를 말없이 지우지 않는다 — 내가 만든 줄이므로 내가 치워야 한다.
       대신 왜 비어 있는지를 적어 둔다. */
    const why = !view ? "친구가 아닙니다"
      : !src ? "공개가 끝났습니다"
        : !canMirror(src.take) ? "미러링이 꺼졌습니다" : null;
    if (why) return { ...f, mirrorOf: who, broken: why, mirrorTake: "none" };

    const edit = canEdit(src!.take);
    /* 함께 고치는 폴더라면 **내가 넣은 작품**도 그 안에 있다. 내 작품은 원본 폴더 번호로
       이어져 있으므로(setWorkFolders 참고), 내 쪽 폴더 번호를 하나 더 달아 준다 —
       그래야 이 폴더를 열었을 때 남의 것과 내 것이 한자리에 보인다. */
    if (edit) {
      for (const w of works) {
        if (w.mirror || !w.folders.includes(src!.id)) continue;
        if (!w.folders.includes(f.id)) w.folders = [...w.folders, f.id];
      }
    }
    for (const w of view!.works) {
      // 내가 넣은 것은 위에서 이미 제자리를 잡았다 — 남의 작품으로 다시 놓지 않는다
      if (edit && (w as any).owner === me) continue;
      if (!w.folders.includes(src!.id)) continue;
      /* **이미 내가 담아 둔 작품이면 내 것이 이긴다.** 내 것에는 내 일정·별점·기록이
         붙어 있어 실제로 다루는 쪽이고, 비쳐 온 쪽은 고칠 수도 없다. 둘 다 보이면
         어느 것을 눌러야 하는지 알 수 없으므로, 그 자리에 내 것을 놓는다. */
      const mine = mineByKey.get(keyOf(w));
      if (mine) { if (!mine.folders.includes(f.id)) mine.folders = [...mine.folders, f.id]; continue; }

      const had = placed.get(w.id);
      if (had) { had.folders.push(f.id); continue; }
      /* 함께 고치는 폴더에서 **남이 넣은 작품**은 폴더 안에서만 보인다. 그 사람이 정한
         일정이 내 캘린더를 채우면, 내가 보기로 한 것과 남이 넣어 둔 것이 뒤섞인다.
         마음에 들면 「내 목록에 담기」로 한 번 눌러 내 것으로 만든다. */
      const owner = (w as any).owner ?? f.mirror.owner;
      const row = asGuest(w, f.id, owner, nameOf(owner), src!.take, edit);
      placed.set(w.id, row);
      works.push(row);
    }
    return { ...f, mirrorOf: who, broken: null, mirrorTake: src!.take, canEdit: edit };
  });
  return { folders: out, works };
}

/** 클라이언트가 화면을 그리는 데 필요한 전부. 1인용이라 한 번에 내려준다. */
function stateSnapshot(user: User) {
  const { folders, works } = withMirrors(user.id);
  const ids = new Set<string>([...works.map(w => w.platformId), ...PLATFORMS.map(p => p.id)]);
  return {
    works,
    folders,
    /* 보관 폴더는 folders 와 **따로** 실어 보낸다. 한 배열에 섞으면 폴더 탭이 그것까지
       세우고, 공유·초대 화면도 함께 훑게 된다 — 표를 가른 뜻이 화면에서 무너진다. */
    archFolders: listArchFolders(user.id),
    settings: getSettings(user.id),
    platforms: platformViews(user.id, ids),
    me: { id: user.id, provider: user.provider, name: user.name,
          email: user.email, avatar: user.avatar,
          displayName: user.displayName },
    /* 친구 **목록**은 여기 싣지 않는다. 쓰는 곳은 폴더 탭의 "친구 폴더 보기" 와 사이드
       메뉴뿐인데, 앱을 열 때마다 따라오면 캘린더만 보고 나가는 사람에게는 그냥 버려진다.
       200명이면 17KB다. 사이드 메뉴에 적을 숫자만 담고, 목록은 GET /api/friends 로 부른다. */
    friendCount: isGuest(user) ? 0 : countFriends(user.id),
    // 폴더 탭의 알림 아이콘에 적을 숫자. 목록은 열 때 따로 부른다.
    folderInvites: isGuest(user) ? [] : folderInvites(user.id),
    /* 끊겼다는 소식. 새로 고칠 때 함께 실어 보내는 것이 곧 "알림이 오는" 길이다 —
       웹소켓을 붙들고 있을 만큼 급한 소식이 아니다. */
    folderNotices: isGuest(user) ? [] : folderNotices(user.id),
    // 0이면 클라이언트가 사이트 이름을 물으러 갈 이유가 없다
    siteNamesPending: pendingSiteNames(user.id).length,
  };
}

/* ── 작품 쓰기 ────────────────────────────────────────────── */
/** 주소를 읽고 **담아도 되는지 가린다.** 담기와 붙이기가 같은 잣대를 쓰도록 한 자리에 둔다.

    **없는 페이지는 담지 않는다.** 여기서 막는 것은 「없다고 확신할 수 있는 것」뿐이다 —
    그쪽이 404 라 했거나, 깊은 주소를 물었는데 대문으로 튕겼거나(없는 작품 번호).

    못 읽은 것(403·시간 초과)은 막지 않는다. 사람이 눈으로 보고 온 페이지를 우리가
    못 읽었다고 거절하면 안 된다 — CGV 가 그렇다. 그쪽은 화면에서 경고만 한다.

    **generic 도 막지 않는다.** 그건 「없다」가 아니라 「우리가 못 읽었다」이다 —
    카카오페이지는 화면을 브라우저에서 그려서 어느 작품 주소든 같은 대문 태그를 주고,
    네이버 지도도 그렇다. 멀쩡한 페이지라 사람이 제목을 직접 적어 담으면 되는데,
    여기서 막으면 그 플랫폼이 통째로 담을 수 없게 된다(실제로 두 곳이 걸렸다). */
async function readUrl(raw: string): Promise<{ r: Extract<Resolved, { ok: true }> } | { bad: any }> {
  const r = await resolveUrl(raw, knownUrl);
  if (r.ok && r.dead && r.dead !== "generic")
    return { bad: { ok: false, dead: r.dead, reason:
      r.dead === "notfound" ? "그 주소에 페이지가 없습니다. 주소를 다시 확인해 주세요."
        : r.dead === "moved" ? "그 콘텐츠를 찾을 수 없습니다 — 주소가 대문으로 넘어갑니다."
          : "그런 주소가 없습니다. 도메인을 다시 확인해 주세요." } };
  if (!r.ok) return { bad: r };
  return { r };
}

/* 공유로 들어온 한 줄을 담는다.

   **이 판단은 여기 한 곳에만 있다.** 예전에는 서비스 워커가 같은 일을 한 벌 더 하고
   있었는데(sw.js 의 handleShare), 이제 들어오는 문이 셋이다 — 브라우저의 웹 공유 대상,
   iOS 「단축어」, 안드로이드 앱. 문마다 판단을 두면 언젠가 서로 다르게 굴고, 그때 「어떤
   기기에서 공유했느냐에 따라 다르게 담긴다」는 가장 알아채기 어려운 종류의 어긋남이 된다.

   **제목을 그 페이지에서 받아왔을 때만 담는다**(origin === "og"). 짐작한 제목으로 조용히
   담으면 담긴 줄 알고 지나갔다가 나중에 엉뚱한 이름을 발견한다. 못 받아왔으면 담지 않고
   사람에게 넘긴다 — 그 판단은 사람이 할 일이다. */
async function intakeShared(user: User, raw: string): Promise<
  | { kind: "empty" }
  | { kind: "ask"; raw: string }
  | { kind: "saved"; title: string; made: boolean }
> {
  // 「제목 https://…」 처럼 글이 섞여 와도 주소만 집는다 (앱의 부팅 코드와 같은 잣대)
  const m = raw.match(/https?:\/\/\S+/);
  const target = m ? m[0] : raw.trim();
  if (!target) return { kind: "empty" };
  const ask = { kind: "ask" as const, raw: raw || target };

  let got;
  try { got = await readUrl(target); } catch { return ask; }
  if ("bad" in got || got.r.origin !== "og" || !got.r.title) return ask;
  const r = got.r;

  const { work, made } = upsertWork(user.id, {
    platformId: applyMerge(user.id, r.platform.id), seriesId: r.seriesId, title: r.title,
    description: r.description, mediaType: r.mediaType, listUrl: r.listUrl, appUrl: r.appUrl,
    coverUrl: r.coverUrl, coverAspect: r.coverAspect, episode: r.episode, schedule: r.schedule,
    folders: [],
    /* **「자동 저장된 콘텐츠」로 들어간다**(filed: false). 사람이 폴더도 일정도 고르지
       않은 것이라 목록에 바로 세우면 뒤섞인다. 나중에 「확인」을 눌러 제자리로 보낸다. */
    filed: false, color: null,
  });
  return { kind: "saved", title: work.title, made };
}

function upsertWork(userId: string, input: {
  platformId: string; seriesId: string; title: string; description: string | null; mediaType: string;
  listUrl: string; appUrl: string | null; coverUrl: string | null; coverAspect: number | null;
  episode: string | null;
  schedule: { mode: string; days: number[]; next: number | null; source: string };
  folders: string[]; filed: boolean; color?: string | null;
}): { work: Work; made: boolean } {
  const now = Date.now();
  /* **휴지통만 「없는」 것으로 본다.** 거기 있는 것은 새로 만든다 — 내려둔 것과 새로
     담는 것은 별개다. 되살리면 그때 매겨 둔 별점과 폴더가 딸려 와 「새로 담았다」와
     다른 것이 생긴다.

     **보관은 다르다.** 그건 들고 있는 것이라, 새 줄을 만들면 같은 작품이 화면에
     두 장 선다. 그 줄에 정보를 새로 적고 **상태는 건드리지 않는다** — 보관이면
     보관인 채로 배지를 달고 선다. 목록으로 되돌리는 일은 「복구」가 맡는다:
     주소를 한 번 더 담았다는 것이 「다시 볼 참이다」라는 뜻은 아니다. */
  /* **공용 줄을 먼저 세운다.** 이미 있으면 그대로 쓴다 — 남이 담아 둔 줄을 내가 담는다고
     고쳐 쓰면 그 사람 화면의 제목과 표지가 말없이 바뀐다. */
  const urlId = findOrMakeUrl({
    platformId: input.platformId, seriesId: input.seriesId, listUrl: input.listUrl,
    appUrl: input.appUrl, mediaType: input.mediaType, title: input.title,
    description: input.description,
    coverUrl: input.coverUrl, coverAspect: input.coverAspect, episode: input.episode,
  });

  const existing = db.prepare(
    `SELECT id, sched_mode, sched_days, sched_next, sched_from
       FROM work WHERE user_id = ? AND url_id = ? AND state <> 'dropped'`)
    .get(userId, urlId) as {
      id: string; sched_mode: string; sched_days: string;
      sched_next: number | null; sched_from: number | null;
    } | undefined;

  if (existing) {
    /* **이미 담아 둔 것이면 적어 온 설정을 그대로 새로 적는다.**

       한때 여기서 열어 본 때와 폴더만 건드렸다. 제목을 지키려던 것이었다 — 사이트가 준
       제목으로 무조건 덮어써서 고쳐 둔 제목이 날아간 적이 있었다. 그런데 그 방패가
       **일정·색까지 함께 막고 있었다**: 같은 주소를 다시 담으며 일정을 고치고 색을 골라
       「담기」를 눌러도 아무 일도 일어나지 않았다. 화면은 「담았습니다」라 하고 값은 그대로였다.

       고칠 곳은 여기가 아니라 **화면**이었다. 등록 시트가 이미 담아 둔 작품이면 지금
       값을 띄우므로(resolve 의 mine), 이제 화면에 뜬 값이 곧 저장될 값이다 — 덮어쓰기는
       사고가 아니라 사람이 보고 누른 결과다.

       제목만은 두 층이다. 공용 줄과 **같으면 덮어쓰기를 비운다** — 값만 같고 덮어쓰기가
       남아 있으면 나중에 공용 제목이 나아져도 이 사람만 옛것을 본다(PATCH 와 같은 규칙). */
    /* **소개글은 여기서 건드리지 않는다.** 등록 화면은 그것을 보여 주기만 하고 고치는
       칸을 두지 않는다 — 화면에 없는 값을 저장이 바꾸면, 다시 담았다는 이유로 고쳐 둔
       소개글이 말없이 사라진다. 고치는 자리는 작품 설정이다. */
    const base = db.prepare("SELECT title FROM url WHERE id = ?")
      .get(urlId) as { title: string };
    const days = JSON.stringify(input.schedule.days);
    /* 일정이 **실제로 바뀐 때만** 시작점을 새로 찍는다. 안 바꾸고 폴더만 손보려던 사람의
       "이 일정이 언제부터였나" 를 지운다면 캘린더의 지난 자국이 함께 지워진다. */
    const moved = existing.sched_mode !== input.schedule.mode
      || existing.sched_days !== days
      || (existing.sched_next ?? null) !== (input.schedule.next ?? null);
    db.prepare(`UPDATE work SET last_at = ?, title = ?, color = ?, filed = MAX(filed, ?),
        sched_mode = ?, sched_days = ?, sched_next = ?, sched_source = ?, sched_from = ?
      WHERE id = ?`)
      .run(now, base.title === input.title ? null : input.title, input.color ?? null,
        input.filed || input.folders.length ? 1 : 0,
        input.schedule.mode, days, input.schedule.next, input.schedule.source,
        moved ? now : existing.sched_from ?? now, existing.id);
    /* 폴더는 **보이는 대로** 맞춘다. 한때 합집합이었는데, 시트가 지금 폴더를 띄우게 된
       뒤로는 체크를 풀어도 그대로 남는 자리가 된다 — 보고 누른 것과 다른 결과다. */
    setWorkFolders(userId, existing.id, input.folders);
    return { work: getWork(userId, existing.id)!, made: false };
  }

  /* 내 줄에는 **덮어쓸 값을 비워 둔다**(title·cover 는 NULL). 담는 순간에는 고친 것이
     없으니 공용 줄 것을 그대로 보게 된다. platform_id 만은 제 값이 필요하다 — 그건
     덮어쓰기가 아니라 내 분류라서 「도메인 떼어내기」가 여기를 고친다.

     **적어 온 제목이 공용 줄과 다르면 그때는 비워 두지 않는다.** 남이 먼저 담아 둔 주소면
     공용 줄에 이미 제목이 있다. 그 위에 내가 고쳐 적은 것을 버리면, 「첫 제목」이라 적고
     담았는데 목록에는 남의 제목이 서 있다. 「고친 것이 없으니 비워 둔다」가 맞으려면
     고친 것이 있을 때는 적어야 한다 — 같으면 여전히 비운다(그래야 공용 줄이 나아질 때 따라간다). */
  const id = newId("w");
  const base = db.prepare("SELECT title FROM url WHERE id = ?").get(urlId) as { title: string };
  db.prepare(`INSERT INTO work
      (id, user_id, url_id, platform_id, title, state, filed, visits, last_at, added_at,
       sched_mode, sched_days, sched_next, sched_source, sched_from, color)
    VALUES (?,?,?,?,?, 'active', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, urlId, input.platformId,
      base.title === input.title ? null : input.title,
      input.filed || input.folders.length ? 1 : 0, now, now,
      input.schedule.mode, JSON.stringify(input.schedule.days),
      input.schedule.next, input.schedule.source, now, input.color ?? null);
  if (input.folders.length) setWorkFolders(userId, id, input.folders);
  return { work: getWork(userId, id)!, made: true };
}

/* ── 담아가기 ─────────────────────────────────────────────
   친구 목록에 있는 것을 **내 것으로 한 벌 떠 온다**. 떠 온 뒤로는 서로 상관이 없다 —
   내가 고쳐도 친구 것은 그대로고, 친구가 고쳐도 내 것은 그대로다.

   무엇을 베끼고 무엇을 안 베끼는지의 잣대는 하나다:
   **그 작품에 대한 것은 베끼고, 그 사람과 작품 사이의 것은 베끼지 않는다.**
   제목 · 표지 · 플랫폼 · 주소 · 연재 일정은 앞쪽이고, 별점 · 본 횟수 · 마지막으로 연 때 ·
   캘린더 점 색은 뒤쪽이다. 뒤쪽까지 따라오면 내가 보지도 않은 작품에 남의 기록이 붙는다. */

/** 표지가 친구가 올린 파일이면 내 것으로 한 장 떠 온다.
    주소만 베끼면 친구가 그 작품을 지울 때 파일도 함께 지워져 내 표지가 깨진다. */
async function copyCover(srcUrl: string | null, mineId: string): Promise<string | null> {
  if (!srcUrl) return null;
  const hit = /^\/covers\/([A-Za-z0-9_-]+)\.(jpg|png|webp)(\?|$)/.exec(srcUrl);
  if (!hit) return srcUrl;                 // 바깥 사이트의 그림이면 주소 그대로 쓴다
  const [, srcId, ext] = hit;
  try {
    await copyFile(pathResolve(COVERS, `${srcId}.${ext}`), pathResolve(COVERS, `${mineId}.${ext}`));
    return `/covers/${mineId}.${ext}?t=${Date.now()}`;
  } catch {
    return null;                           // 파일이 없으면 표지 없이 담는다
  }
}

/** other 의 작품 가운데 내가 담아갈 수 있는 것.

    두 갈래다.
    ① 그 사람이 나에게 연 폴더에 있고, 그 폴더가 담아가기를 허락한 것.
    ② **내가 주인인 함께 고치는 폴더**에 그 사람이 넣어 둔 것 — 그 폴더는 내 것이라
       sharedView 에 잡히지 않는다. 같이 꾸린 목록에서 마음에 드는 것을 내 것으로
       만드는 일이라 막을 이유가 없다. */
function takable(me: string, other: string): Map<string, Work> {
  const out = new Map<string, Work>();
  const view = sharedView(other, me);
  // 담아가도 좋다고 열어 둔 폴더를 먼저 갈라 둔다 — 작품마다 폴더 목록을 훑지 않게
  const open = new Set(view.folders.filter(f => canCopy(f.take)).map(f => f.id));
  for (const w of view.works) if (w.folders.some(id => open.has(id))) out.set(w.id, w);

  for (const f of listFolders(me).filter(x => !x.mirror && canEdit(x.take)))
    for (const w of contributedWorks(f.id, { only: other })) out.set(w.id, w);
  return out;
}

/** 한 편을 담아 간다. 이미 있으면 새로 만들지 않고 폴더에만 넣는다. */
async function takeWork(userId: string, src: Work, folderIds: string[]):
  Promise<{ already: boolean; id: string }> {
  /* 휴지통만 「없는」 것으로 본다 — upsertWork 와 같은 잣대다. 거기 내려둔 것이 있다고
     담아가기가 막히면, 화면에는 「이미 담겨 있습니다」라는데 어디에도 안 보인다.
     보관에 있는 것은 들고 있는 것이라 폴더에만 넣어 준다. */
  const urlId = findOrMakeUrl({
    platformId: src.platformId, seriesId: src.seriesId, listUrl: src.listUrl,
    appUrl: src.appUrl, mediaType: src.mediaType, title: src.title,
    description: src.description ?? null,
    coverUrl: src.coverUrl, coverAspect: src.coverAspect, episode: src.episode,
  });
  const had = db.prepare(
    "SELECT id FROM work WHERE user_id = ? AND url_id = ? AND state <> 'dropped'")
    .get(userId, urlId) as { id: string } | undefined;

  /* 이미 담아 둔 것은 건드리지 않는다 — 제목을 내가 고쳐 뒀을 수도 있고, 보관함에
     내려둔 것을 말없이 되살릴 일도 아니다. 폴더에만 함께 넣어 준다. */
  if (had) {
    if (folderIds.length) {
      const cur = getWork(userId, had.id)!.folders;
      setWorkFolders(userId, had.id, [...new Set([...cur, ...folderIds])]);
    }
    return { already: true, id: had.id };
  }

  const id = newId("w");
  const now = Date.now();
  const cover = await copyCover(src.coverUrl, id);

  /* **친구가 고쳐 둔 값만 물려받는다.** src 는 이미 합쳐진 모양이라(친구 덮어쓰기 ?? 공용),
     공용 줄과 같은 값이면 덮어쓸 것이 없다 — 비워 두면 공용 것을 그대로 보게 되고,
     나중에 공용 줄이 나아지면 그것도 따라온다. 다른 값일 때만 내 쪽에 적는다.
     표지는 친구 것을 내 파일로 떠 왔으므로(copyCover) 늘 내 값이다. */
  const u = db.prepare(`SELECT title, description, cover_url, cover_aspect, episode
      FROM url WHERE id = ?`)
    .get(urlId) as { title: string; description: string | null; cover_url: string | null;
                     cover_aspect: number | null; episode: string | null };
  const mine = <T>(v: T, base: T): T | null => (v === base ? null : v);

  db.prepare(`INSERT INTO work
      (id, user_id, url_id, platform_id, title, description, cover_url, cover_aspect, episode,
       state, filed, visits, last_at, added_at,
       sched_mode, sched_days, sched_next, sched_source, sched_from, color)
    VALUES (?,?,?,?,?,?,?,?,?, 'active', 1, 0, ?, ?, ?, ?, ?, ?, ?, NULL)`)
    .run(id, userId, urlId, src.platformId,
      mine(src.title, u.title),
      mine(src.description ?? null, u.description),
      cover === u.cover_url ? null : cover,
      mine(src.coverAspect, u.cover_aspect),
      mine(src.episode, u.episode),
      now, now,
      src.schedule.mode, JSON.stringify(src.schedule.days),
      src.schedule.next, src.schedule.source, now);
  if (folderIds.length) setWorkFolders(userId, id, folderIds);
  return { already: false, id };
}

/* 퍼가기 값은 쉼표로 이은 집합이다("copy,mirror"). 빈 글자는 비공개.
   모르는 낱말이 섞여 있으면 통째로 물린다 — 반만 받아들이면 고른 것과 저장된 것이 달라진다. */
const TAKE_WORDS = ["copy", "mirror", "edit"];
/* **폴더의 갈래는 둘이고 섞이지 않는다.**

   ┌ 일반 폴더 — ""(비공개) · "copy" · "mirror" · "copy,mirror"
   └ 공유 폴더 — "edit" 하나뿐

   한때 셋을 자유롭게 조합할 수 있었다. 그러면 함께 쓰자고 만든 폴더가 편집 한 번으로
   아무나 담아갈 수 있는 것이 되고, 갈래마다 대상이 다른데(「함께 쓰자」와 「아무나
   담아가라」) 범위는 하나뿐이라 그 하나가 둘을 동시에 뜻하게 된다. 화면은 만들 때
   갈래를 갈라 그 조합이 아예 안 생기게 하고, 여기서는 그것을 값으로 못 박는다. */
const validTake = (v: unknown): boolean =>
  typeof v === "string" &&
  (v === "" || v.split(",").every(w => TAKE_WORDS.includes(w))) &&
  (!v.split(",").includes("edit") || v === "edit");
/** 차례를 고정한다 — 같은 조합이 늘 같은 글자가 되어야 견주기 쉽다 */
const normTake = (v: string): string =>
  TAKE_WORDS.filter(w => v.split(",").includes(w)).join(",");

/* ── 라우팅 ───────────────────────────────────────────────── */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  /* nosniff 를 켜 두었으므로 여기 없는 확장자는 octet-stream 으로 나가고, 크롤러는
     robots.txt 를 글로 읽지 못한다 — 막으려고 둔 파일이 막지 못하게 된다. */
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

/* 배포해도 옛 화면이 그대로이던 문제.

   우리는 정적 파일에 no-cache 를 붙여 보내지만, 앞에 선 Cloudflare 가 그걸 무시하고
   브라우저에 "4시간 동안 다시 묻지 말라"(max-age=14400)고 고쳐 보낸다. 그래서 새로 고쳐도
   기기가 옛 app.js 를 그대로 썼다. 무료 요금제의 기본값이라 원본에서는 끌 수 없다.

   그래서 주소 자체를 바꾼다 — 파일 내용에서 판 번호를 만들어 /app.js?v=... 로 부른다.
   내용이 바뀌면 주소가 바뀌므로 캐시에 있을 수가 없다. index.html 은 CF가 캐시하지 않는
   (Cache-Control: no-cache · cf-cache-status: DYNAMIC) 문서라 늘 새 판 번호를 들고 온다. */
const VERSIONED = ["app.js", "styles.css"];
let assetV: string | null = null;

async function assetVersion(): Promise<string> {
  if (assetV) return assetV;                       // 파일은 이미지에 구워져 있어 한 번이면 된다
  const h = createHash("sha256");
  for (const f of VERSIONED) {
    try { h.update(await readFile(join(PUBLIC, f))); } catch { /* 없으면 셈에서 뺀다 */ }
  }
  return (assetV = h.digest("hex").slice(0, 8));
}

/* 화면을 이루는 파일들은 이미지에 구워져 있어 도는 동안 바뀌지 않는다. 그런데 부를 때마다
   stat 하고 readFile 하고 있었다 — app.js 만 160KB 라, 사람이 앱을 한 번 열 때마다 그만큼을
   디스크에서 다시 퍼 올린 셈이다. 판 번호(assetV)를 한 번만 셈하는 것과 같은 이치로,
   내용도 한 번만 읽어 들고 있는다.

   index.html 은 판 번호를 박아 넣은 뒤의 모습으로 갈무리한다 — 그 치환도 매번 할 일이 아니다.
   data/ 아래 표지 그림은 사용자가 올리고 지우는 것이라 여기 오지 않는다(따로 다룬다). */
const served = new Map<string, { body: Buffer; type: string; etag: string }>();

async function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<boolean> {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, "");
  const file = join(PUBLIC, rel === "" ? "index.html" : rel);
  if (!file.startsWith(PUBLIC)) return false;           // 경로 탈출 차단

  let hit = served.get(file);
  if (!hit) {
    try {
      const s = await stat(file);
      if (!s.isFile()) return false;
      let body = await readFile(file);
      if (extname(file) === ".html") {
        const v = await assetVersion();
        body = Buffer.from(body.toString("utf8")
          .replace(/\/(app\.js|styles\.css)"/g, `/$1?v=${v}"`), "utf8");
      }
      /* 표딱지(ETag)는 내용에서 뽑는다 — 파일이 도는 동안 바뀌지 않으므로 한 번이면 된다. */
      hit = {
        body, type: MIME[extname(file)] ?? "application/octet-stream",
        etag: '"' + createHash("sha256").update(body).digest("hex").slice(0, 16) + '"',
      };
      served.set(file, hit);
    } catch { return false; }
  }
  /* no-cache 는 "쓰지 말라"가 아니라 "쓰기 전에 물어보라"다. 그런데 물어볼 거리를
     안 주고 있었다 — 표딱지가 없으니 되물을 때마다 늘 200 에 몸통 전부를 얹어 보냈다.
     index.html 은 CF가 캐시하지 않는 문서라 **새로 고칠 때마다** 3.2KB 가 그대로 오갔고,
     app.js 는 네 시간이 지나 브라우저가 되물으면 264KB 를 통째로 다시 받았다.
     표딱지를 붙여 두면 같은 판일 때 머리 몇 줄로 끝난다. */
  const asked = req.headers["if-none-match"];
  if (asked && asked.split(",").some(t => t.trim() === hit.etag)) {
    res.writeHead(304, { ETag: hit.etag, "Cache-Control": "no-cache" });
    res.end();
    return true;
  }
  res.writeHead(200, {
    "Content-Type": hit.type,
    "Content-Length": hit.body.length,
    "Cache-Control": "no-cache",
    ETag: hit.etag,
  });
  res.end(hit.body);
  return true;
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL, user: User): Promise<boolean> {
  const p = url.pathname;
  const m = req.method ?? "GET";
  const seg = p.split("/").filter(Boolean);            // ["api", "works", ":id", ...]

  /* 친구 기능은 게스트에게 열지 않는다. 되찾을 수 없는 계정으로 남과 이어지면,
     기기를 잃었을 때 상대 쪽에만 흔적이 남는다. 화면에서도 막지만 여기서 한 번 더 막는다 —
     막는 자리는 화면이 아니라 서버여야 한다. */
  const guestBlocked = ["friends", "invites"].includes(seg[1] ?? "");
  if (guestBlocked && isGuest(user)) {
    json(res, 403, { ok: false, reason: "게스트는 친구 기능을 쓸 수 없습니다. 로그인하면 쓸 수 있어요." });
    return true;
  }


  if (p === "/api/state" && m === "GET") {
    /* `?fresh=1` 은 **앱을 새로 열 때**만 붙는다 — 지난번에 읽어 둔 소식을 걷고 값을 준다.
       화면을 다시 그릴 때마다 걷으면, 목록을 보는 사이에 다시 그려질 때 눈앞에서 줄이
       사라진다. 걷는 것과 값을 주는 것을 한 왕복에 묶는 이유는 순서 때문이다:
       나중에 걷으면 방금 내보낸 목록에 걷힌 것이 그대로 남는다. */
    if (url.searchParams.get("fresh") === "1") sweepNotices(user.id);
    json(res, 200, stateSnapshot(user));
    return true;
  }

  if (p === "/api/resolve" && m === "POST") {
    const { url: target } = await readJson(req);
    const r = await resolveUrl(String(target ?? ""), knownUrl);
    /* **이미 담아 둔 작품이면 그 줄을 함께 준다.** 등록 화면이 지금 값을 띄우려면 필요하고,
       열쇠(구간+시리즈)는 담을 때 쓰는 것과 같아야 하므로 여기서 답한다 — 화면이 짐작하면
       구간 합치기(applyMerge)를 지나온 뒤의 id 를 모른다. */
    const mine = r.ok
      ? findKeptWork(user.id, applyMerge(user.id, r.platform.id), r.seriesId) : null;
    json(res, r.ok ? 200 : 400, r.ok ? { ...r, originLabel: originLabel(r), mine } : r);
    return true;
  }

  if (p === "/api/works" && m === "POST") {
    const b = await readJson(req);

    /* 주소 없이 제목만으로 담기. 개봉을 기다리는 영화처럼 아직 페이지가 없는 것들이 있다.
       시리즈 식별자를 새로 만들어 주므로 같은 제목을 여러 번 담아도 서로 덮지 않는다. */
    if (!String(b.url ?? "").trim()) {
      const title = String(b.title ?? "").trim();
      if (!title) { json(res, 400, { ok: false, reason: "제목이 필요합니다." }); return true; }
      const { work } = upsertWork(user.id, {
        platformId: "note", seriesId: newId("n"), title, description: null, mediaType: "link",
        listUrl: "", appUrl: null, coverUrl: null, coverAspect: null, episode: null,
        schedule: normSchedule(b.schedule),
        folders: Array.isArray(b.folders) ? b.folders : [],
        filed: true,
        color: typeof b.color === "string" && /^#[0-9a-fA-F]{6}$/.test(b.color)
          ? b.color.toLowerCase() : null,
      });
      json(res, 201, { ok: true, work });
      return true;
    }

    const got = await readUrl(String(b.url ?? ""));
    if ("bad" in got) { json(res, 400, got.bad); return true; }
    const r = got.r;
    const title = String(b.title ?? r.title ?? "").trim();
    if (!title) { json(res, 400, { ok: false, reason: "제목이 필요합니다." }); return true; }
    const platformId = applyMerge(user.id, r.platform.id);
    const hex = (v: unknown) =>
      typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
    const { work, made } = upsertWork(user.id, {
      platformId, seriesId: r.seriesId, title, description: r.description, mediaType: r.mediaType,
      listUrl: r.listUrl, appUrl: r.appUrl, coverUrl: r.coverUrl,
      coverAspect: r.coverAspect, episode: r.episode,
      schedule: b.schedule ? normSchedule(b.schedule) : r.schedule,
      folders: Array.isArray(b.folders) ? b.folders : [],
      filed: !!b.filed, color: hex(b.color),
    });
    /* **등록 화면에서 고친 소개글은 내 덮어쓰기로 남는다.** 받아온 글은 공용 줄(url)의
       것이라 그 자리에 적으면 같은 주소를 담은 남의 화면까지 바뀐다 — 담을 때든 고칠
       때든 내 줄에만 적는다(setOwnDescription 이 그 규칙을 쥐고 있다).
       값을 안 보내면 손대지 않는다: 그때는 공용 줄이 그대로 비쳐 보인다. */
    /* 적었으면 **다시 읽어서** 돌려준다 — 위의 work 는 덮어쓰기 전에 뜬 줄이라
       방금 적은 소개글이 안 담겨 있다. 화면은 곧 reload 하지만, 돌려주는 값이
       사실과 다르면 그 값을 믿는 다음 사람이 틀린다. */
    const saved = typeof b.description === "string"
      ? (setOwnDescription(work.id, b.description), getWork(user.id, work.id) ?? work)
      : work;
    /* 구간 이름은 여기서 정하지 않는다. 이 페이지가 밝힌 og:site_name 을 믿었더니
       교보문고 전자책 페이지가 "IMDb" 라고 답하는 일이 있었다 — 남의 메타 태그를 그대로
       베껴 둔 것이다. 사이트 이름은 대문에 물어보는 게 맞고, 그건 site-names 가 한다. */
    // 만든 것과 고친 것은 다른 일이다 — 화면이 다른 말을 해야 한다
    json(res, made ? 201 : 200, { ok: true, work: saved, made });
    return true;
  }

  /* 이미 쌓인 도메인들의 이름을 뒤늦게 채운다. 한 번에 몇 개씩만 — 한 사이트당 한 번이면 된다. */
  if (p === "/api/platforms/site-names" && m === "POST") {
    const todo = pendingSiteNames(user.id);
    const batch = todo.slice(0, 6);
    const got = await Promise.all(batch.map(async t =>
      [t.id, await fetchSiteName(t.host).catch(() => ({ read: false, name: null }))] as const));
    // 못 읽었어도 줄은 남긴다. 안 그러면 같은 사이트를 끝없이 다시 묻는다 —
    // 다시 시도할 길은 편집 화면의 "가져오기"로 열어 두었다.
    for (const [id, r] of got) { const h = hostOf(id); if (h) setSite(h, r.name, r.icon); }
    json(res, 200, {
      ok: true,
      filled: got.filter(([, r]) => r.name).length,
      remaining: Math.max(0, todo.length - batch.length),
    });
    return true;
  }

  /* 두 도메인 구간을 하나로 합친다. 이름이 겹칠 때 사용자가 고른다. */
  if (p === "/api/platforms/merge" && m === "POST") {
    const b = await readJson(req);
    const from = String(b.from ?? ""), to = String(b.to ?? "");
    if (!from.startsWith(DOMAIN_PREFIX) || !to.startsWith(DOMAIN_PREFIX) || from === to) {
      json(res, 400, { ok: false, reason: "도메인 구간끼리만 합칠 수 있습니다." });
      return true;
    }
    const wide = !!b.wide;   // "이 도메인 아래 전부"
    const base = registrableDomain(from.slice(DOMAIN_PREFIX.length));

    // 옮길 구간을 정한다. 넓게 잡으면 같은 등록 단위의 형제들도 함께 온다.
    const targets = wide
      ? (db.prepare(`SELECT DISTINCT platform_id FROM work
             WHERE user_id = ? AND platform_id LIKE '${DOMAIN_PREFIX}%' AND platform_id != ?`)
          .all(user.id, to) as { platform_id: string }[])
          .map(r => r.platform_id)
          .filter(id => registrableDomain(id.slice(DOMAIN_PREFIX.length)) === base)
      : [from];

    // 같은 주소가 양쪽에 있으면 UNIQUE에 걸린다 — 그 행은 건드리지 않고 넘어간다
    const upd = db.prepare(
      "UPDATE OR IGNORE work SET platform_id = ? WHERE user_id = ? AND platform_id = ?");
    let moved = 0;
    for (const id of targets) moved += upd.run(to, user.id, id).changes;

    const merges = getMerges(user.id);
    for (const id of targets) merges[id] = to;
    // 못 박아 둔 것(자기 자신을 가리키던 것)은 넓게 합칠 때 풀어 준다
    if (wide) for (const k of Object.keys(merges))
      if (merges[k] === k && k.startsWith(DOMAIN_PREFIX)
        && registrableDomain(k.slice(DOMAIN_PREFIX.length)) === base) delete merges[k];
    // 옮겨간 자리를 향하던 규칙도 함께 옮겨 사슬이 생기지 않게 한다
    for (const k of Object.keys(merges)) if (targets.includes(merges[k])) merges[k] = to;
    kvSet(user.id, "domainMerges", merges);

    if (wide) {
      const wild = getWild(user.id);
      wild[base] = to;
      kvSet(user.id, "domainMergeWild", wild);
    }

    // 사라진 구간에 붙어 있던 표시 설정·사이트 이름은 정리한다 (받는 쪽 값을 남긴다)
    for (const key of ["overrides", "siteNames"] as const) {
      const obj = kvGet<Record<string, unknown>>(user.id, key, {});
      let touched = false;
      for (const id of targets) if (id in obj) { delete obj[id]; touched = true; }
      if (touched) kvSet(user.id, key, obj);
    }
    json(res, 200, { ok: true, moved, merged: targets.length, platform: platformView(user.id, to) });
    return true;
  }

  /* 합쳐 둔 호스트를 도로 떼어낸다. 합치기가 있으면 되돌릴 길도 있어야 한다. */
  if (p === "/api/platforms/split" && m === "POST") {
    const b = await readJson(req);
    const pid = String(b.platformId ?? ""), host = String(b.host ?? "");
    if (!pid.startsWith(DOMAIN_PREFIX) || !host) {
      json(res, 400, { ok: false, reason: "도메인 구간에서만 떼어낼 수 있습니다." });
      return true;
    }
    const target = DOMAIN_PREFIX + host;
    if (target === pid) { json(res, 400, { ok: false, reason: "그 구간의 본래 주소입니다." }); return true; }

    // 그 호스트에서 온 작품만 골라 되돌린다 — 원래 주소가 list_url 에 남아 있다
    const rows = db.prepare(`SELECT w.id, u.list_url
      FROM work w JOIN url u ON u.id = w.url_id
      WHERE w.user_id = ? AND w.platform_id = ?`)
      .all(user.id, pid) as { id: string; list_url: string }[];
    const upd = db.prepare("UPDATE OR IGNORE work SET platform_id = ? WHERE id = ?");
    let moved = 0;
    for (const r of rows) {
      let h: string;
      try { h = new URL(r.list_url).hostname.replace(/^www\./, "").replace(/^m\./, ""); }
      catch { continue; }
      if (h !== host) continue;
      moved += upd.run(target, r.id).changes;
    }

    const merges = getMerges(user.id);
    // 자기 자신을 가리키게 해 못 박는다 — 도메인 규칙이 다시 끌어가지 못하게
    merges[target] = target;
    kvSet(user.id, "domainMerges", merges);

    /* 떼어낸 구간의 이름은 그 호스트의 대문에서 새로 받아온다. 합쳐질 때 지워졌으므로
       그냥 두면 주소만 남는다. 부모와 같은 이름이 나올 수도 있지만, 일부러 떼어낸 것이니
       그건 사용자가 고칠 일이다 — 이름이 없는 것보다 낫다. */
    const got = await fetchSiteName(host).catch(() => ({ read: false, name: null, icon: null }));
    if (got.read) setSite(host, got.name, got.icon);
    else forgetSite(host);            // 못 읽었으면 줄을 남기지 않아 나중에 다시 묻는다

    json(res, 200, { ok: true, moved, platform: platformView(user.id, target) });
    return true;
  }

  /* 한 도메인의 이름을 사이트에 다시 물어본다 — 편집 화면의 "가져오기" */
  if (seg[0] === "api" && seg[1] === "platforms" && seg[2] && seg[3] === "site-name" && m === "POST") {
    const pid = decodeURIComponent(seg[2]);
    if (!pid.startsWith(DOMAIN_PREFIX)) { json(res, 400, { ok: false, reason: "도메인 묶음이 아닙니다." }); return true; }
    const r = await fetchSiteName(pid.slice(DOMAIN_PREFIX.length))
      .catch(() => ({ read: false, name: null, icon: null }));
    if (!r.read) { json(res, 200, { ok: false, reason: "사이트를 읽지 못했습니다." }); return true; }
    setSite(pid.slice(DOMAIN_PREFIX.length), r.name, r.icon);

    json(res, 200, r.name
      ? { ok: true, name: r.name, platform: platformView(user.id, pid) }
      : { ok: false, reason: "이 사이트는 이름을 밝히지 않습니다." });
    return true;
  }

  if (seg[0] === "api" && seg[1] === "works" && seg[2]) {
    const id = seg[2];
    if (seg[3] === "open" && m === "POST") {
      const r = db.prepare("UPDATE work SET visits = visits + 1, last_at = ? WHERE id = ? AND user_id = ?")
        .run(Date.now(), id, user.id);
      /* 남의 작품을 보러 갔으면 **내 쪽 기록**에 적는다. 그 사람의 last_at 을 건드리면
         내가 열 때마다 친구 목록이 흔들린다. */
      if (!r.changes) markSeen(user.id, id, true);
      json(res, 200, { ok: true, work: getWork(user.id, id) });
      return true;
    }
    /* 눌러 봤다는 표시만 남긴다 — 목록의 붉은 점을 끄려는 것이다.

       마지막으로 연 때(last_at)는 건드리지 않는다. 그건 **실제로 보러 간 때**이고
       목록의 차례를 정하는 값이라, 열어만 봐도 앞으로 튀어 오르면 차례가 뜻을 잃는다. */
    if (seg[3] === "seen" && m === "POST") {
      const r = db.prepare("UPDATE work SET visits = MAX(visits, 1) WHERE id = ? AND user_id = ?")
        .run(id, user.id);
      // 내 작품이 아니면 내 쪽 기록에 적는다 — 남의 칸을 고칠 수는 없다
      if (!r.changes) markSeen(user.id, id, false);
      json(res, 200, { ok: true });
      return true;
    }
    if (m === "PATCH") {
      const b = await readJson(req);
      const w = getWork(user.id, id);
      if (!w) { json(res, 404, { ok: false, reason: "없는 콘텐츠입니다." }); return true; }

      /* **주소를 붙이는 일은 옮겨 다는 일이다.**

         주소 없이 담아 둔 항목(개봉을 기다리는 영화 같은 것)에 나중에 페이지가 생기면
         그 주소를 붙인다. 한때 화면이 이 일을 「새로 담고 옛것을 지우는」 것으로 했는데,
         그러면 무엇을 새 줄에 넘길지 매번 손으로 세어야 했다 — 실제로 **별점과 소개글이
         빠져 있었고**, 보관해 둔 것이 목록으로 되살아났다. 넘길 것을 세는 방식은 값이
         하나 늘 때마다 조용히 틀린다.

         옮겨 달면 셀 것이 없다. 이 줄은 그대로 두고 **가리키는 곳만 바꾼다** — 별점 ·
         본 횟수 · 담은 때 · 상태 · 폴더 · 일정 · 표지가 다 제자리에 남는다.

         **자리가 비어 있을 때만 옮긴다.** 그 주소를 이미 들고 있으면 한 사람에게 같은
         작품이 두 줄이 된다(idx_work_kept). 표가 거절하기 전에 뜻이 담긴 답을 준다. */
      if (typeof b.url === "string" && b.url.trim()) {
        const got = await readUrl(b.url.trim());
        if ("bad" in got) { json(res, 400, got.bad); return true; }
        const r = got.r;
        const platformId = applyMerge(user.id, r.platform.id);
        const urlId = findOrMakeUrl({
          platformId, seriesId: r.seriesId, listUrl: r.listUrl, appUrl: r.appUrl,
          mediaType: r.mediaType, title: String(b.title ?? r.title ?? "").trim() || w.title,
          description: r.description,
          coverUrl: r.coverUrl, coverAspect: r.coverAspect, episode: r.episode,
        });
        if (urlId !== w.urlId) {
          const taken = db.prepare(`SELECT state FROM work
              WHERE user_id = ? AND url_id = ? AND id <> ? AND state <> 'dropped'`)
            .get(user.id, urlId, id) as { state: string } | undefined;
          if (taken) {
            json(res, 409, { ok: false, reason: taken.state === "watched"
              ? "그 주소는 이미 보관에 있는 콘텐츠입니다." : "그 주소는 이미 목록에 있는 콘텐츠입니다." });
            return true;
          }
          const old = w.urlId;
          db.prepare("UPDATE work SET url_id = ?, platform_id = ? WHERE id = ?")
            .run(urlId, platformId, id);
          /* 주소 없이 담은 줄은 저 혼자 쓰던 공용 줄을 남긴다(seriesId 를 그때 새로
             지었으므로 남이 쓸 일이 없다). 아무도 안 가리키면 거둔다 — 안 그러면
             「직접 입력」 자국이 표에 쌓이기만 한다. */
          const still = db.prepare("SELECT 1 FROM work WHERE url_id = ? LIMIT 1").get(old);
          if (!still) db.prepare("DELETE FROM url WHERE id = ?").run(old);
        }
      }
      if (b.schedule) {
        // 일정을 새로 정하면 그 시점부터 적용된다 — 과거 요일까지 소급하지 않는다
        db.prepare(`UPDATE work SET sched_mode=?, sched_days=?, sched_next=?,
            sched_source='user', sched_from=? WHERE id=?`)
          .run(b.schedule.mode ?? w.schedule.mode,
            JSON.stringify(b.schedule.days ?? w.schedule.days),
            b.schedule.next ?? null, Date.now(), id);
      }
      /* 공용 줄과 **같은 제목이면 덮어쓰기를 비운다.** 그래야 「원래대로 돌려놓았다」가
         실제로 원래대로가 된다 — 값만 같고 덮어쓰기가 남아 있으면, 나중에 공용 줄의
         제목이 나아져도 이 사람만 옛것을 계속 본다. */
      if (typeof b.title === "string" && b.title.trim()) {
        const want = b.title.trim();
        const base = db.prepare("SELECT u.title FROM work w JOIN url u ON u.id = w.url_id WHERE w.id = ?")
          .get(id) as { title: string } | undefined;
        db.prepare("UPDATE work SET title=? WHERE id=?")
          .run(base && base.title === want ? null : want, id);
      }
      /* **소개글도 두 층이다.** 제목과 같은 규칙: 공용 줄과 같으면 덮어쓰기를 비운다.

         빈 문자열은 「공용 것을 쓴다」가 아니라 **「비워 둔다」**로 읽는다 — 사이트가
         적어 둔 것이 마음에 안 들어 지웠는데 그것이 도로 살아나면 지운 뜻이 없다.
         공용 줄이 비어 있을 때만 둘이 같아져 덮어쓰기가 비워진다. */
      if (typeof b.description === "string") setOwnDescription(id, b.description);
      /* 언제 내렸는지 남긴다 — 캘린더에 "보던 기간" 을 그리는 데 쓴다.

         **보관은 한 작품에 한 줄이다.** 같은 것을 두 번 보고 두 번 끝내면 목록에
         똑같은 줄이 둘 선다 — 「끝까지 본 시리즈」는 몇 번 봤는지가 아니라 무엇을 봤는지의
         목록이라, 거기서 같은 작품이 둘인 것은 알려 주는 바가 없다. 옛 줄을 거두고 새 줄이
         그 자리를 잇는다: 방금 끝낸 쪽이 제목·별점·폴더까지 지금 것을 들고 있다.

         **휴지통은 다르다.** 담았다 버리고 다시 담았다 또 버린 것은 저마다 다른 판단이고,
         공유 폴더에서 온 같은 작품을 따로 버릴 수도 있어야 한다(그 이야기가 「휴지통에
         있어도 url 추가가 가능」이다). 그래서 여기서 거르지 않는다. */
      /* **복구는 자리가 비어 있을 때만 된다.** 목록에 같은 작품이 이미 서 있으면
         살아 있는 것끼리의 UNIQUE 인덱스(idx_work_live)가 거절하는데, 그건 500 으로
         떨어져 「무슨 일이 났는지」를 말해 주지 못한다. 여기서 미리 가려 뜻이 담긴 답을
         준다 — 화면은 이 답을 그대로 사람에게 옮긴다. */
      if (b.state === "active") {
        const taken = db.prepare(`SELECT a.state FROM work a
            WHERE a.user_id = ? AND a.state <> 'dropped' AND a.id <> ?
              AND a.url_id = (SELECT url_id FROM work WHERE id = ?)`)
          .get(user.id, id, id) as { state: string } | undefined;
        // 어디에 있는지까지 말한다 — 「이미 있다」만으로는 어디를 찾아봐야 할지 모른다
        if (taken) {
          json(res, 409, { ok: false, reason: taken.state === "watched"
            ? "이미 보관에 있는 콘텐츠입니다." : "이미 목록에 있는 콘텐츠입니다." });
          return true;
        }
      }
      if (typeof b.state === "string" && ["active", "watched", "dropped"].includes(b.state)) {
        if (b.state === "watched")
          db.prepare(`DELETE FROM work WHERE user_id = ? AND state = 'watched' AND id <> ?
              AND url_id = (SELECT url_id FROM work WHERE id = ?)`).run(user.id, id, id);
        db.prepare("UPDATE work SET state=?, state_at=? WHERE id=?").run(b.state, Date.now(), id);
      }
      /* 표지 주소 — 사이트가 막아 표지를 못 받아온 경우에 직접 넣는다.
         빈 문자열이면 지운다. http(s) 만 받는다 — 다른 얼개(data:, javascript:)를
         그대로 담으면 화면에 그대로 실린다. */
      if (typeof b.coverUrl === "string") {
        const v = b.coverUrl.trim();
        if (!v) db.prepare("UPDATE work SET cover_url=NULL, cover_aspect=NULL WHERE id=?").run(id);
        else if (/^https?:\/\//i.test(v))
          db.prepare("UPDATE work SET cover_url=?, cover_aspect=NULL WHERE id=?").run(v, id);
      }
      // 캘린더 점 색 — #rrggbb, null이면 플랫폼 색으로 되돌린다
      if (b.color === null || (typeof b.color === "string" && /^#[0-9a-fA-F]{6}$/.test(b.color)))
        db.prepare("UPDATE work SET color=? WHERE id=?")
          .run(b.color ? b.color.toLowerCase() : null, id);
      // 별점 — 1~5, null이면 지운다. 그 밖의 값은 조용히 무시한다.
      if (b.rating === null || (typeof b.rating === "number" && b.rating >= 1 && b.rating <= 5))
        db.prepare("UPDATE work SET rating=? WHERE id=?").run(b.rating && Math.round(b.rating), id);
      if (typeof b.coverAspect === "number" && b.coverAspect > 0)
        db.prepare("UPDATE work SET cover_aspect=? WHERE id=?").run(b.coverAspect, id);
      if (typeof b.filed === "boolean")
        db.prepare("UPDATE work SET filed=? WHERE id=?").run(b.filed ? 1 : 0, id);
      if (Array.isArray(b.folders)) setWorkFolders(user.id, id, b.folders);
      /* 보관 폴더 — **하나거나 null**. 배열을 받지 않는 것이 곧 규칙이다: 여럿을 담을
         자리가 없으니 둘에 넣는 요청이 아예 만들어지지 않는다.
         값을 안 보내면 손대지 않는다(undefined 와 null 은 다른 말이다). */
      if (b.archFolder === null || typeof b.archFolder === "string")
        setArchFolder(user.id, id, b.archFolder || null);
      json(res, 200, { ok: true, work: getWork(user.id, id) });
      return true;
    }
    if (m === "DELETE") {
      // 남의 것을 지우려 하면 아무 행도 안 지워진다. 그때 200을 주면 지운 것처럼 보인다.
      // 올려 둔 표지도 함께 지운다 — 안 그러면 주인 없는 파일만 쌓인다
      for (const ext of ["jpg", "png", "webp"])
        await unlink(pathResolve(COVERS, `${id}.${ext}`)).catch(() => {});
      const rw = db.prepare("DELETE FROM work WHERE id = ? AND user_id = ?").run(id, user.id);
      if (!rw.changes) { json(res, 404, { ok: false, reason: "없는 콘텐츠입니다." }); return true; }
      json(res, 200, { ok: true });
      return true;
    }
  }

  /** 보낸 값이면 다듬어 돌려주고, 아예 안 보냈으면 옛 값을 그대로 둔다.
      빈 글자를 **지우라는 뜻**으로 살려 두는 것이 요점이다. */
  const field = (b: any, key: string, was: string) =>
    typeof b[key] === "string" ? b[key].trim() : was;

  /* 공개 대상과 퍼가기 권한을 받아 담는다. 만들 때와 고칠 때가 같은 값을 받으므로
     받아들이는 잣대도 한 곳에 둔다.

     공개 대상은 **실제 친구만** 받는다. 친구가 아닌 사람의 아이디를 끼워 넣어도 저장되지
     않게 여기서 거른다 — 지우는 쪽이 아니라 담는 쪽에서 막는 것이 안전하다. */
  /** 보낸 퍼가기 값이 규칙에 맞는가. 안 보냈으면 손댈 것이 없으니 통과다.

      **조용히 버리면 안 된다.** 한때 applyShare 가 validTake 를 통과하지 못한 값을 그냥
      건너뛰었는데, 그러면 만들기는 201, 고치기는 200 으로 답하면서 저장된 값은 딴 것이었다
      — 고른 것과 저장된 것이 달라지는, 바로 그 자리를 막으려던 검사가 그 탈을 냈다. */
  const badTake = (b: any) => b.take !== undefined && !validTake(b.take);

  const applyShare = (id: string, b: any) => {
    if (b.share && ["none", "all", "some"].includes(b.share.mode) && !isGuest(user)) {
      const want: string[] = Array.isArray(b.share.with)
        ? b.share.with.filter((x: any) => typeof x === "string") : [];
      /* 함께 고치는 폴더는 **부른다고 곧바로 참여자가 되지 않는다** — 수락을 받는다.
         퍼가기 값이 이번에 함께 왔으면 그것을, 아니면 지금 폴더에 적힌 것을 본다. */
      const take = validTake(b.take)
        ? b.take : getFolder(user.id, id)?.take;
      setFolderShare(id, b.share.mode as ShareMode, want.filter(v => areFriends(user.id, v)),
        canEdit(take as TakeMode));
    }
    /* 퍼가기 권한 — 공개하지 않은 폴더에는 뜻이 없지만, 껐다 켰다 할 때마다 값이
       날아가면 다시 정해야 하므로 공개 여부와 상관없이 그대로 담아 둔다.

       갈래를 못 바꾼다는 빗장은 **여기가 아니라 고치는 자리(PATCH)에 있다** — 만들 때도
       이 함수를 지나가는데, 그때는 아직 기본값(copy)만 앉아 있어 공유 폴더를 세우려는
       첫 요청이 제 손에 걸린다. */
    if (validTake(b.take)) setFolderTake(id, normTake(b.take) as TakeMode);
  };

  /* ── 보관 폴더 ─────────────────────────────────────────
     폴더와 **다른 길**이다. 공유·초대·미러링이 붙지 않으므로 확인할 것도 그만큼 없다:
     내 것인가, 이름이나 아이콘이 있는가. 그 둘뿐이다. */
  if (p === "/api/arch-folders" || p.startsWith("/api/arch-folders/")) {
    const id = p.slice("/api/arch-folders/".length);
    const nameEmoji = (b: any) => {
      const name = String(b.name ?? "").trim().slice(0, 40);
      const emoji = String(b.emoji ?? "").trim().slice(0, 8);
      /* 폴더와 같은 잣대 — 이름이나 아이콘 중 하나만 있으면 가리킬 수 있다.

         **빈 아이콘을 몰래 채우지 않는다.** 한때 여기서 📦 로 되돌렸는데, 그러면 화면의
         「없음」이 눌리지 않는 단추가 된다 — 골라 놓고 저장하면 아이콘이 도로 살아난다.
         folder 쪽 createFolder 가 같은 까닭으로 같은 말을 적어 두고 있다. */
      return !name && !emoji ? null : { name, emoji };
    };

    if (p === "/api/arch-folders" && m === "POST") {
      const v = nameEmoji(await readJson(req));
      if (!v) { json(res, 400, { ok: false, reason: "이름이나 아이콘 중 하나는 정해 주세요." }); return true; }
      json(res, 201, { ok: true, folder: createArchFolder(user.id, v.name, v.emoji) });
      return true;
    }
    if (id && m === "PATCH") {
      const v = nameEmoji(await readJson(req));
      if (!v) { json(res, 400, { ok: false, reason: "이름이나 아이콘 중 하나는 정해 주세요." }); return true; }
      const f = renameArchFolder(user.id, id, v.name, v.emoji);
      if (!f) { json(res, 404, { ok: false, reason: "없는 폴더입니다." }); return true; }
      json(res, 200, { ok: true, folder: f });
      return true;
    }
    if (id && m === "DELETE") {
      if (!deleteArchFolder(user.id, id)) {
        json(res, 404, { ok: false, reason: "없는 폴더입니다." }); return true;
      }
      json(res, 200, { ok: true });
      return true;
    }
  }

  if (p === "/api/folders" && m === "POST") {
    const b = await readJson(req);
    const name = String(b.name ?? "").trim();
    const emoji = String(b.emoji ?? "").trim();
    /* **이름과 아이콘 중 하나만 있으면 된다.** 아이콘 하나로 알아보는 폴더가 있고
       (🍿 · 📚), 이름만으로 충분한 폴더도 있다. 둘 다 없으면 목록에서 가리킬 것이
       없으므로 그때만 막는다. */
    if (!name && !emoji) {
      json(res, 400, { ok: false, reason: "이름이나 아이콘 중 하나는 정해 주세요." });
      return true;
    }
    if (badTake(b)) {
      json(res, 400, { ok: false, reason: "폴더는 일반 폴더이거나 공유 폴더입니다 — 섞을 수 없습니다." });
      return true;
    }
    const { id } = createFolder(user.id, { name, emoji });
    applyShare(id, b);
    json(res, 201, { ok: true, folder: getFolder(user.id, id) });
    return true;
  }

  /* 표지 올리기. 몸통은 그림 바이트 그대로다 — 개인용 한 파일짜리 업로드에
     multipart 를 끌어들일 이유가 없다. 형식과 크기는 여기서 가른다. */
  if (seg[1] === "works" && seg[3] === "cover" && m === "PUT") {
    const id = seg[2];
    const w = getWork(user.id, id);
    if (!w) { json(res, 404, { ok: false, reason: "없는 콘텐츠입니다." }); return true; }

    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[type];
    if (!ext) { json(res, 415, { ok: false, reason: "JPEG · PNG · WebP 만 올릴 수 있습니다." }); return true; }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > COVER_MAX) { json(res, 413, { ok: false, reason: "그림이 너무 큽니다 (1MB까지)." }); return true; }
      chunks.push(c as Buffer);
    }
    if (!size) { json(res, 400, { ok: false, reason: "빈 파일입니다." }); return true; }

    // 옛 파일은 지운다 — 형식이 바뀌면 이름이 달라져 그대로 두면 쌓이기만 한다
    for (const old of ["jpg", "png", "webp"])
      await unlink(pathResolve(COVERS, `${id}.${old}`)).catch(() => {});
    await writeFile(pathResolve(COVERS, `${id}.${ext}`), Buffer.concat(chunks));

    /* 주소 끝에 시각을 붙인다. 파일 이름이 그대로면 브라우저가 옛 그림을 계속 쓴다 —
       바꿨는데 안 바뀌는 것처럼 보인다. */
    const url = `/covers/${id}.${ext}?t=${Date.now()}`;
    db.prepare("UPDATE work SET cover_url=?, cover_aspect=NULL WHERE id=?").run(url, id);
    json(res, 200, { ok: true, coverUrl: url });
    return true;
  }

  if (seg[0] === "api" && seg[1] === "folders" && seg[2]) {
    const id = seg[2];
    const mine = getFolder(user.id, id);

    /* 별은 **비추는 폴더에도** 켤 수 있다 — 이름·아이콘과 달리 그건 주인의 값이 아니라
       내 목록의 차례를 정하는 나만의 표시다. 그래서 아래 미러링 빗장보다 앞에 둔다. */
    if (seg[3] === "star" && m === "PUT") {
      const b = await readJson(req);
      const ok = starFolder(user.id, id, !!b.starred);
      json(res, ok ? 200 : 404, ok ? { ok: true, starred: !!b.starred }
        : { ok: false, reason: "없는 폴더입니다." });
      return true;
    }

    /* **이름과 아이콘은 비추는 폴더에서도 내 것이다.**

       그 줄은 내 표에 있고(createFolder 가 만든다), 주인 것을 담을 때 한 번 베껴 왔을
       뿐이다. 내 목록에서 어떻게 부를지는 내가 정하는 것이 맞다 — 주인이 「웹툰」이라
       불러도 나는 「지롱이 추천」이라 부를 수 있고, 그렇게 고쳐도 주인 화면은 그대로다.

       공개 설정은 다르다. 그건 **원본 폴더**에 딸린 것이라 주인만 정한다. */
    if (mine?.mirror && m === "PATCH") {
      const b = await readJson(req);
      if (b.share !== undefined || b.take !== undefined) {
        json(res, 403, { ok: false, reason: "공개 설정은 폴더 주인만 정할 수 있습니다." });
        return true;
      }
      const next = field(b, "name", mine.name);
      const nextEmoji = field(b, "emoji", mine.emoji);
      if (!next && !nextEmoji) {
        json(res, 400, { ok: false, reason: "이름이나 아이콘 중 하나는 정해 주세요." });
        return true;
      }
      db.prepare("UPDATE folder SET name = ?, emoji = ? WHERE id = ?").run(next, nextEmoji, id);
      json(res, 200, { ok: true, folder: getFolder(user.id, id) });
      return true;
    }
    if (m === "PATCH") {
      if (!mine) { json(res, 404, { ok: false, reason: "없는 폴더입니다." }); return true; }
      const b = await readJson(req);

      /* **빈 값과 안 보낸 값은 다르다.**

         한때 `b.name?.trim() || null` 로 받았는데, 빈 글자는 거짓이라 그대로 null 이 되고
         COALESCE 가 옛 이름을 도로 집었다 — 이름을 지우고 저장해도 이름이 그대로 남았다.
         "고치지 마" 와 "비워 줘" 를 가르는 것은 값의 참거짓이 아니라 **왔는지 안 왔는지**다. */
      const next = field(b, "name", mine.name);
      const nextEmoji = field(b, "emoji", mine.emoji);
      if (!next && !nextEmoji) {
        json(res, 400, { ok: false, reason: "이름이나 아이콘 중 하나는 정해 주세요." });
        return true;
      }
      /* **갈래는 만들 때 정해지고 바뀌지 않는다.** 일반 폴더를 공유 폴더로, 또는 그 반대로
         뒤집는 길이 있으면 만들 때 가른 것이 뜻을 잃는다 — 함께 쓰던 폴더가 편집 한 번에
         아무나 담아가는 것이 되는 바로 그 길이다. 화면에는 그 칸이 아예 없으므로,
         여기 닿는 것은 짜맞춘 요청뿐이다. */
      if (badTake(b)) {
        json(res, 400, { ok: false, reason: "폴더는 일반 폴더이거나 공유 폴더입니다 — 섞을 수 없습니다." });
        return true;
      }
      if (b.take !== undefined && canEdit(mine.take) !== canEdit(b.take as TakeMode)) {
        json(res, 403, { ok: false, reason: "폴더의 갈래는 만든 뒤에 바꿀 수 없습니다." });
        return true;
      }
      db.prepare("UPDATE folder SET name = ?, emoji = ? WHERE id = ?").run(next, nextEmoji, id);

      applyShare(id, b);
      json(res, 200, { ok: true, folders: listFolders(user.id) });
      return true;
    }
    /* 폴더에 **여럿을 한꺼번에** 넣는다. 한 편씩 PATCH 로 보내면 스무 편에 스무 번을
       왕복하고, 중간에 하나가 어긋나면 절반만 들어간 채로 남는다.

       넣기만 하고 빼지 않는다 — 빼는 것은 작품 쪽 「폴더 바꾸기」가 맡는 일이라
       여기에 두면 같은 일을 하는 자리가 둘이 된다.

       **넣을 곳은 원본 폴더다.** 함께 쓰는 폴더에 불려 간 쪽에서 넣으면 내 껍데기가
       아니라 주인의 폴더에 걸려야 주인에게도, 함께 쓰는 다른 사람에게도 보인다.
       mayFile 이 껍데기를 거절하므로 여기서 바꿔 준다. */
    if (seg[3] === "works" && m === "POST") {
      if (!mine) { json(res, 404, { ok: false, reason: "없는 폴더입니다." }); return true; }
      const b = await readJson(req);
      const want: string[] = Array.isArray(b.works)
        ? b.works.filter((x: any) => typeof x === "string") : [];
      const into = mine.mirror ? mine.mirror.folder : id;
      /* **옮기기도 여기서 한다.** from 을 주면 그 폴더에서 빼면서 넣는다 — 넣기와 빼기를
         두 요청으로 나누면 그 사이에 한쪽만 끝난 상태가 남는다(넣었는데 안 빠졌거나
         그 반대). 한 작품에 대해 한 번에 적으면 그런 자리가 없다. */
      const from = typeof b.from === "string" && b.from !== into ? b.from : null;
      let n = 0, moved = 0;
      for (const wid of new Set(want)) {
        const w = getWork(user.id, wid);          // 내 작품만 — 남의 것은 여기서 걸린다
        if (!w) continue;
        const had = w.folders.includes(into);
        const next = (from ? w.folders.filter(x => x !== from) : [...w.folders]);
        if (!had) next.push(into);
        // 바뀌는 것이 없으면 건드리지 않는다 — 쓰지 않아야 last_at 도 안 흔들린다
        if (had && next.length === w.folders.length) continue;
        setWorkFolders(user.id, wid, next);
        const now = getWork(user.id, wid)!.folders;
        // mayFile 이 막았으면 늘지 않는다 — 넣었다고 답하지 않으려고 다시 센다
        if (!had && now.includes(into)) n++;
        if (from && !now.includes(from)) moved++;
      }
      json(res, 200, { ok: true, added: n, moved });
      return true;
    }

    /* ── 공유자 명단 ──
       폴더 설정의 「친구에게 공개」는 명단을 **통째로 다시 쓰는** 자리다. 한 사람을 더
       부르거나 한 사람만 끊는 일은 거기서 하기에 손이 많이 가고, 잘못 건드리면 남은
       사람까지 함께 떨어져 나간다. 그래서 「공유자」 창에 더하기와 끊기를 따로 둔다.

       **주인만 할 수 있다.** 불려 간 쪽의 폴더는 껍데기라 mine.mirror 가 차 있고,
       그때는 명단을 손댈 자격이 없다. */
    if (seg[3] === "people") {
      if (!mine || mine.mirror) {
        json(res, 403, { ok: false, reason: "폴더 주인만 명단을 고칠 수 있습니다." });
        return true;
      }
      if (m === "POST") {
        const b = await readJson(req);
        const want: string[] = Array.isArray(b.add)
          ? b.add.filter((x: any) => typeof x === "string") : [];
        // 친구만 부른다 — 담는 쪽에서 막는다(applyShare 와 같은 잣대)
        const ok = want.filter(x => areFriends(user.id, x));
        const n = inviteToFolder(id, ok);
        json(res, 200, { ok: true, added: n, folders: listFolders(user.id) });
        return true;
      }
      if (seg[4] && m === "DELETE") {
        const gone = unlinkFromFolder(id, seg[4]);
        json(res, gone ? 200 : 400, gone ? { ok: true, folders: listFolders(user.id) }
          : { ok: false, reason: "「모든 친구에게」 연 폴더는 한 사람만 끊을 수 없습니다. 공개 대상을 먼저 좁혀 주세요." });
        return true;
      }
    }

    if (m === "DELETE") {
      /* 폴더를 지워도 작품은 남는다 — 묶음만 사라진다.

         주인이 함께 고치던 폴더를 지우면 친구들이 걸어 둔 이음줄도 CASCADE 로 함께
         걷힌다. 남의 작품은 제 주인에게 그대로 남고 이 묶음에서만 빠진다.

         반대로 **함께 쓰기를 그만두는 쪽**은 제 껍데기만 지워서는 모자란다 — 내가 걸어 둔
         이음줄은 원본 폴더에 붙어 있어 그대로 남고, 주인은 이제 남이 된 사람의 작품을
         계속 보게 된다. 나가기 전에 내 것을 걷어 간다. */
      if (mine?.mirror) leaveFolder(user.id, mine.mirror.folder);
      /* 지우기 **전에** 알린다 — 지우고 나면 누가 닿아 있었는지도, 폴더 이름이 무엇이었는지도
         물어볼 데가 없다. 내가 비추던 폴더를 지우는 것은 나 혼자 손 떼는 일이라 알릴 것이 없다. */
      if (mine && !mine.mirror) noticeBreak(id, "폴더가 사라졌습니다");
      const rf = db.prepare("DELETE FROM folder WHERE id = ? AND user_id = ?").run(id, user.id);
      if (!rf.changes) { json(res, 404, { ok: false, reason: "없는 폴더입니다." }); return true; }
      json(res, 200, { ok: true });
      return true;
    }
  }

  /* ── 표시 이름 — 친구에게 보이는 유일한 신원 ── */
  if (p === "/api/me" && m === "PUT") {
    const b = await readJson(req);
    const want = cleanName(String(b.displayName ?? ""));
    if (!want) { json(res, 400, { ok: false, reason: "이름을 입력해 주세요." }); return true; }
    /* 겹치는 이름은 담지 않는다. 표시 이름이 **친구에게 보이는 유일한 신원**이라,
       같은 이름이 둘이면 초대 명단에서 어느 쪽인지 가릴 것이 없다. */
    const saved = setDisplayName(user.id, want);
    if (!saved) {
      json(res, 409, { ok: false, reason: "중복된 닉네임입니다." });
      return true;
    }
    json(res, 200, { ok: true, displayName: saved });
    return true;
  }

  /* ── 초대 ── */
  if (p === "/api/invites" && m === "POST") {
    if (!user.displayName) {
      json(res, 400, { ok: false, reason: "먼저 표시 이름을 정해 주세요." });
      return true;
    }
    const inv = createInvite(user.id);
    json(res, 201, { ok: true, ...inv, url: `${BASE_URL}/?invite=${inv.code}` });
    return true;
  }

  if (seg[0] === "api" && seg[1] === "invites" && seg[2]) {
    const code = seg[2];
    const owner = inviteOwner(code);
    if (!owner) {
      json(res, 404, { ok: false, reason: "만료되었거나 없는 초대입니다." });
      return true;
    }
    if (m === "GET") {
      json(res, 200, {
        ok: true, from: { id: owner.id, displayName: owner.displayName ?? "이름 없음" },
        me: owner.id === user.id, already: areFriends(user.id, owner.id),
      });
      return true;
    }
    if (seg[3] === "accept" && m === "POST") {
      if (owner.id === user.id) {
        json(res, 400, { ok: false, reason: "자기 자신은 친구로 추가할 수 없습니다." });
        return true;
      }
      if (!user.displayName) {
        json(res, 400, { ok: false, reason: "먼저 표시 이름을 정해 주세요." });
        return true;
      }
      addFriend(user.id, owner.id);
      json(res, 200, { ok: true, friend: { id: owner.id, displayName: owner.displayName } });
      return true;
    }
  }

  /* ── 폴더 초대 ── */
  if (p === "/api/folder-invites" && m === "GET") {
    json(res, 200, { ok: true, invites: folderInvites(user.id) });
    return true;
  }
  if (seg[0] === "api" && seg[1] === "folder-invites" && seg[2] && m === "POST") {
    const id = seg[2];
    if (seg[3] === "accept") {
      const f = acceptFolder(user.id, id);
      if (!f) { json(res, 404, { ok: false, reason: "이미 지난 초대입니다." }); return true; }
      json(res, 200, { ok: true, folder: f });
      return true;
    }
    if (seg[3] === "decline") {
      // 한 번만 부른다 — 두 번 부르면 첫 번째가 이미 지워 놓아 늘 없다고 답한다
      const gone = declineFolder(user.id, id);
      json(res, gone ? 200 : 404,
        gone ? { ok: true } : { ok: false, reason: "이미 지난 초대입니다." });
      return true;
    }
  }

  /* ── 끊겼다는 소식 ──
     실시간으로 밀어 주지 않는다. 새로 고칠 때 /api/state 에 함께 실려 오고, 여기서는
     읽음 표시와 치우기만 맡는다. */
  if (p === "/api/folder-notices" && m === "POST") {
    readNotices(user.id);
    json(res, 200, { ok: true });
    return true;
  }

  /* ── 친구 ── */
  if (p === "/api/friends" && m === "GET") {
    json(res, 200, { ok: true, friends: listFriends(user.id) });
    return true;
  }

  if (seg[0] === "api" && seg[1] === "friends" && seg[2]) {
    const other = seg[2];
    if (!areFriends(user.id, other)) {
      json(res, 403, { ok: false, reason: "친구가 아닙니다." });
      return true;
    }
    if (seg[3] === "shared" && m === "GET") {
      const owner = getUser(other)!;
      const view = sharedView(other, user.id);
      /* **함께 쓰는 폴더는 여기 두지 않는다.** 그건 이미 내 폴더 탭에 제 줄로 서 있다 —
         남의 폴더를 구경하는 자리에 또 나오면 같은 폴더가 두 곳에 있는 셈이고, 어느 쪽에서
         넣어야 하는지 알 수 없다. 안쪽 sharedView 는 그대로 둔다: 비추는 폴더를 채우고
         담아갈 것을 고르는 데 그 목록이 쓰인다. */
      const folders = view.folders.filter(f => !canEdit(f.take));
      const keep = new Set(folders.map(f => f.id));
      const works = view.works.filter(w => w.folders.some(id => keep.has(id)));
      const ids = new Set<string>(works.map(w => w.platformId));
      json(res, 200, {
        ok: true,
        friend: { id: owner.id, displayName: owner.displayName ?? "이름 없음" },
        folders, works,
        platforms: platformViews(user.id, ids),
      });
      return true;
    }
    /* 친구가 나에게 공개한 것만 담아 갈 수 있다. 무엇이 보이는지는 sharedView 가
       이미 알고 있으므로, 거기 없는 것을 달라고 하면 그냥 없는 것이다 —
       작품 번호를 넣어 보며 남의 목록을 더듬는 길이 열리지 않는다. */
    if (seg[3] === "take" && m === "POST") {
      const b = await readJson(req);
      const view = sharedView(other, user.id);

      /* **여럿을 한꺼번에.** 폴더 안에서 골라 담을 때 오는 길이다 — 한 편씩 오가면
         열 편에 열 번을 왕복한다.

         담을 수 없는 것은 조용히 건너뛰고 몇이었는지만 세어 돌려준다. 고른 것 하나가
         막혀 있다고 나머지까지 되돌릴 일은 아니다 — 함께 쓰는 폴더에는 갈래가 저마다인
         작품이 섞여 있어, 고르는 사람이 그것을 미리 가릴 길이 없다. */
      if (Array.isArray(b.works)) {
        const can = takable(user.id, other);
        let added = 0, already = 0, skipped = 0;
        for (const raw of b.works.slice(0, 300)) {
          const src = can.get(String(raw));
          if (!src) { skipped++; continue; }
          const r = await takeWork(user.id, src, []);
          if (r.already) already++; else added++;
        }
        json(res, 200, { ok: true, added, already, skipped });
        return true;
      }

      if (b.work) {
        /* 한 작품이 여러 폴더에 들어 있을 수 있는데, 그중 **하나라도** 담아가기를
           허락하면 담을 수 있다 — 주인이 그 작품을 가져가도 좋다고 한 것이다. */
        const src = takable(user.id, other).get(b.work);
        if (!src) { json(res, 403, { ok: false, reason: "담아갈 수 없는 콘텐츠입니다." }); return true; }
        /* 번호를 함께 돌려준다 — 화면이 곧바로 그 작품의 설정 창을 열어, 친구가 정해 둔
           값을 보면서 내 것으로 손볼 수 있게 한다. */
        const { already, id } = await takeWork(user.id, src, []);
        json(res, 200, { ok: true, already, id, title: src.title });
        return true;
      }

      if (b.folder) {
        const src = view.folders.find(f => f.id === b.folder);
        if (!src) { json(res, 404, { ok: false, reason: "볼 수 없는 폴더입니다." }); return true; }
        if (!canCopy(src.take)) {
          json(res, 403, { ok: false, reason: "담아갈 수 없는 폴더입니다." });
          return true;
        }
        const items = view.works.filter(w => w.folders.includes(src.id));

        const { id: fid } = createFolder(user.id, { name: src.name, emoji: src.emoji });
        let added = 0, already = 0;
        for (const w of items) {
          const r = await takeWork(user.id, w, [fid]);
          r.already ? already++ : added++;
        }
        json(res, 200, { ok: true, folder: fid, name: src.name, added, already });
        return true;
      }

      json(res, 400, { ok: false, reason: "무엇을 담을지 알려주세요." });
      return true;
    }

    /* 미러링 — 폴더 한 줄만 만든다. 작품은 베끼지 않는다. */
    if (seg[3] === "mirror" && m === "POST") {
      const b = await readJson(req);
      const view = sharedView(other, user.id);
      const src = view.folders.find(f => f.id === b.folder);
      if (!src) { json(res, 404, { ok: false, reason: "볼 수 없는 폴더입니다." }); return true; }
      if (!canMirror(src.take)) {
        json(res, 403, { ok: false, reason: "미러링할 수 없는 폴더입니다." });
        return true;
      }
      const had = listFolders(user.id).find(f =>
        f.mirror?.owner === other && f.mirror?.folder === src.id);
      if (had) { json(res, 200, { ok: true, already: true, name: src.name }); return true; }

      const { id: fid } = createFolder(user.id,
        { name: src.name, emoji: src.emoji, mirror: { owner: other, folder: src.id } });
      const n = view.works.filter(w => w.folders.includes(src.id)).length;
      json(res, 200, { ok: true, already: false, folder: fid, name: src.name, count: n });
      return true;
    }

    if (m === "PATCH") {
      const b = await readJson(req);
      starFriend(user.id, other, !!b.starred);
      json(res, 200, { ok: true, starred: !!b.starred });
      return true;
    }
    if (m === "DELETE") {
      removeFriend(user.id, other);
      json(res, 200, { ok: true });
      return true;
    }
  }

  if (p === "/api/settings" && m === "PUT") {
    const b = await readJson(req);
    const next: Settings = { ...getSettings(user.id) };
    if (b.openMode === "app" || b.openMode === "web") next.openMode = b.openMode;
    /* **아는 탭만 남긴다.** 걸러내는 김에 차례도 겹치는 것도 정리된다 —
       들어온 배열을 그대로 믿으면 없는 탭 이름이 설정에 눌러앉는다. */
    if (Array.isArray(b.doneIn)) next.doneIn = DONE_TABS.filter(t => b.doneIn.includes(t));
    // 테마 색 — #rrggbb 만 받는다. null 이면 기본으로 되돌린다.
    if (b.themeColor === null) next.themeColor = null;
    else if (typeof b.themeColor === "string" && /^#[0-9a-fA-F]{6}$/.test(b.themeColor))
      next.themeColor = b.themeColor.toLowerCase();
    kvSet(user.id, "settings", next);
    json(res, 200, { ok: true, settings: next });
    return true;
  }

  /* 공유 열쇠. **여기는 쿠키로만 들어온다** — 열쇠로 열쇠를 만들 수 있으면, 한 번 새어
     나간 열쇠가 스스로 새끼를 쳐서 지워도 지워지지 않는다. /api/ 는 통째로 쿠키를 요구하고
     (위의 401), 열쇠가 통하는 곳은 /share 하나뿐이다. */
  if (p === "/api/share-keys" || p.startsWith("/api/share-keys/")) {
    if (p === "/api/share-keys" && m === "GET") {
      json(res, 200, { ok: true, keys: listShareKeys(user.id) });
      return true;
    }
    if (p === "/api/share-keys" && m === "POST") {
      const b = await readJson(req);
      const { id, token } = createShareKey(user.id, String(b.label ?? ""));
      /* **열쇠 값은 이때 한 번만 준다.** 서버에는 해시만 남아서 다시 보여 줄 수가 없다 —
         잃어버리면 새로 만드는 것이 맞다. 그래야 서버가 털려도 열쇠가 함께 털리지 않는다. */
      json(res, 201, { ok: true, id, token, keys: listShareKeys(user.id) });
      return true;
    }
    if (seg[2] && m === "DELETE") {
      if (!deleteShareKey(user.id, decodeURIComponent(seg[2]))) {
        json(res, 404, { ok: false, reason: "없는 열쇠입니다." });
        return true;
      }
      json(res, 200, { ok: true, keys: listShareKeys(user.id) });
      return true;
    }
  }

  if (seg[0] === "api" && seg[1] === "overrides" && seg[2]) {
    const pid = decodeURIComponent(seg.slice(2).join("/"));
    const all = getOverrides(user.id);
    if (m === "PUT") {
      const b = await readJson(req);
      all[pid] = { name: b.name, initial: b.initial, color: b.color, fg: normFg(b.fg) };
      kvSet(user.id, "overrides", all);
      json(res, 200, { ok: true, platform: platformView(user.id, pid) });
      return true;
    }
    if (m === "DELETE") {
      delete all[pid];
      kvSet(user.id, "overrides", all);
      json(res, 200, { ok: true, platform: platformView(user.id, pid) });
      return true;
    }
  }


  return false;
}

/* ── 인증 ─────────────────────────────────────────────────── */
const redirect = (res: ServerResponse, to: string, cookie?: string): void => {
  const h: Record<string, string> = { Location: to };
  if (cookie) h["Set-Cookie"] = cookie;
  res.writeHead(302, h);
  res.end();
};

/** 소개글 덮어쓰기 한 줄. **공용 줄과 같으면 비운다** — 같은 글을 두 층에 겹쳐
    두면 나중에 사이트가 소개글을 고쳤을 때 내 줄이 옛 글을 붙들고 있게 된다.

    담을 때(POST)와 고칠 때(PATCH)가 같은 규칙을 써야 한다. 한쪽만 고치면 등록 화면에서
    적은 것과 설정에서 적은 것이 서로 다르게 저장된다. */
function setOwnDescription(workId: string, text: string): void {
  const want = text.trim().slice(0, 400);
  const base = db.prepare("SELECT u.description FROM work w JOIN url u ON u.id = w.url_id WHERE w.id = ?")
    .get(workId) as { description: string | null } | undefined;
  db.prepare("UPDATE work SET description=? WHERE id=?")
    .run((base?.description ?? "") === want ? null : want, workId);
}

/** 현재 요청의 사용자. 제공자가 하나도 설정되지 않았으면 로컬 계정으로 동작한다. */
function currentUser(req: IncomingMessage): User | null {
  const token = readCookie(req.headers.cookie, COOKIE);
  const u = userFromToken(token);
  if (u) return u;
  if (!localFallbackAllowed()) return null;
  return upsertUser({ provider: "local", providerUid: "local", name: "이 기기" });
}

/* 비밀번호 맞춰보기 막기. 서버가 살아 있는 동안만 기억하면 된다 —
   껐다 켜면 풀리지만, 그 사이에 몰아치는 시도를 막는 것이 목적이다. */
const TRIES = new Map<string, { n: number; until: number }>();
const TRY_MAX = 8, TRY_WINDOW = 10 * 60_000;

function tooManyTries(id: string): string | null {
  const t = TRIES.get(id);
  if (!t) return null;
  if (Date.now() > t.until) { TRIES.delete(id); return null; }
  if (t.n < TRY_MAX) return null;
  const min = Math.ceil((t.until - Date.now()) / 60_000);
  return `너무 여러 번 틀렸습니다. ${min}분 뒤에 다시 해 주세요.`;
}
function failed(id: string): void {
  const t = TRIES.get(id);
  if (t && Date.now() <= t.until) t.n++;
  else TRIES.set(id, { n: 1, until: Date.now() + TRY_WINDOW });
}
const clearTries = (id: string): void => { TRIES.delete(id); };

async function auth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const seg = url.pathname.split("/").filter(Boolean);   // ["auth", provider, "callback"?]
  if (seg[0] !== "auth") return false;
  const providerId = seg[1] ?? "";

  if (seg[2] === "callback") {
    const err = url.searchParams.get("error");
    if (err) { redirect(res, `/?login_error=${encodeURIComponent(err)}`); return true; }
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    /* 지금 게스트로 쓰고 있었다면, 새 계정을 만드는 대신 **쓰던 계정에 이어 붙인다.**
       그러지 않으면 담아 둔 것이 게스트 계정에 갇힌 채 빈 화면으로 시작하게 된다.
       이미 그 제공자로 만든 계정이 따로 있으면 이을 수 없으니 그 계정으로 들어간다. */
    const before = userFromToken(readCookie(req.headers.cookie, COOKIE));
    const guestId = before && isGuest(before) ? before.id : null;

    const r = await completeLogin(providerId, code, state);
    if (!r.ok) { redirect(res, `/?login_error=${encodeURIComponent(r.reason)}`); return true; }
    const linked = guestId ? linkGuest(guestId, r.account) : null;
    const token = createSession((linked ?? r.user).id, req.headers["user-agent"] ?? null);
    redirect(res, "/", cookieHeader(token, 30 * 24 * 3600));
    return true;
  }

  /* 아이디·비밀번호로 가입하고 들어오기.

     되찾을 길(메일 인증 같은 것)을 두지 않았다 — 잊으면 그 계정에는 다시 못 들어간다.
     화면에서 그렇게 알린다. 있지도 않은 "비밀번호 찾기" 를 흉내내는 것보다 낫다. */
  if (providerId === "password" && (seg[2] === "signup" || seg[2] === "login") && req.method === "POST") {
    const b = await readJson(req);
    const id = typeof b.loginId === "string" ? b.loginId.trim() : "";
    const pw = b.password;

    if (!validLoginId(id)) {
      json(res, 400, { ok: false, reason: "아이디는 영문·숫자·밑줄 3~20자로 지어 주세요." });
      return true;
    }
    if (!validPassword(pw)) {
      json(res, 400, { ok: false, reason: "비밀번호는 8자 이상이어야 합니다." });
      return true;
    }

    /* 맞춰보기를 막는다. 아이디마다 세어 두고, 몇 번 틀리면 잠시 쉬게 한다 —
       비밀번호가 아무리 좋아도 무한정 두드릴 수 있으면 언젠가는 뚫린다. */
    const gate = tooManyTries(id);
    if (gate) { json(res, 429, { ok: false, reason: gate }); return true; }

    const before = userFromToken(readCookie(req.headers.cookie, COOKIE));
    const guestId = before && isGuest(before) ? before.id : null;

    let user;
    if (seg[2] === "signup") {
      const hash = await hashPassword(pw);
      // 게스트로 쓰던 중이면 그 계정을 그대로 데려간다 — 담아 둔 것이 갇히지 않게
      user = guestId ? linkGuestPassword(guestId, id, hash) : createPasswordUser(id, hash);
      if (!user) { json(res, 409, { ok: false, reason: "이미 쓰이고 있는 아이디입니다." }); return true; }
    } else {
      const found = passwordUser(id);
      const ok = found ? await verifyPassword(pw, found.hash) : false;
      /* 아이디가 없는 것과 비밀번호가 틀린 것을 **같은 말로** 답한다.
         가려 말하면 어떤 아이디가 있는지 알아낼 수 있다. */
      if (!ok) {
        failed(id);
        json(res, 401, { ok: false, reason: "아이디나 비밀번호가 맞지 않습니다." });
        return true;
      }
      user = found!.user;
      markLogin(user.id);
    }

    clearTries(id);
    const token = createSession(user.id, req.headers["user-agent"] ?? null);
    const payload = JSON.stringify({ ok: true });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
      "Set-Cookie": cookieHeader(token, 30 * 24 * 3600),
    });
    res.end(payload);
    return true;
  }

  /* 게스트로 시작하기. 로그인 없이 바로 쓰되, 쿠키가 유일한 열쇠라
     기기를 바꾸거나 쿠키가 지워지면 되찾을 수 없다 — 화면에서 그렇게 알린다. */
  if (providerId === "guest" && seg.length === 2 && req.method === "POST") {
    const g = createGuest();
    const token = createSession(g.id, req.headers["user-agent"] ?? null);
    const payload = JSON.stringify({ ok: true });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
      "Set-Cookie": cookieHeader(token, 30 * 24 * 3600),
    });
    res.end(payload);
    return true;
  }

  if (seg.length === 2) {
    const to = startLogin(providerId);
    if (!to) { redirect(res, "/?login_error=" + encodeURIComponent("설정되지 않은 로그인입니다.")); return true; }
    redirect(res, to);
    return true;
  }
  return false;
}

/* ── 보안 머리글 ───────────────────────────────────────────

   모든 응답에 같은 것을 얹는다. 자리마다 따로 붙이면 새로 만든 길에서 빠뜨린다 —
   실제로 이 서버에는 여섯 군데의 writeHead 가 있고, 그중 어디가 빠졌는지는
   눈으로 세어야 알 수 있었다. 라우팅 앞에서 한 번에 얹으면 404 와 500 에도 붙는다.

   **CSP** — 표지는 남의 CDN 에서 그대로 가져다 쓰므로 img-src 는 https 전체를 연다.
   그 밖에는 우리 자신과 글꼴뿐이다. 인라인 스타일(style="…")은 화면 곳곳에서 값을
   실어 나르는 방식이라 열어 두지만, **인라인 스크립트는 열지 않는다** — index.html 의
   테마 복원 한 조각만 해시로 통과시킨다(scriptHashes 가 그것을 읽어 만든다).

   **X-Robots-Tag** — 이 서비스는 검색에도 학습에도 실릴 이유가 없는 개인 목록이다.
   robots.txt 가 「오지 마라」라면 이쪽은 「가져갔더라도 싣지 마라」다. 둘 다 지키는
   쪽에만 먹히지만, 지키는 쪽이 대부분이고 안 지키는 쪽은 어차피 로그인에 막힌다. */
const SEC_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai",
};

/** index.html 안의 인라인 <script> 조각들을 CSP 해시로. 파일이 바뀌면 함께 바뀐다. */
function scriptHashes(html: string): string {
  /* 여는 태그에 src 가 없는 <script> 의 몸통. 정규식을 글자로 지어 넘기는 까닭은
     소스에 백슬래시가 줄줄이 들어가면 옮겨 붙이는 과정에서 조용히 상하기 때문이다 —
     실제로 한 번 [sS] 가 [sS] 로 뭉개져 아무것도 안 잡는 정규식이 되었다. */
  const INLINE_SCRIPT = new RegExp(
    "<script(?![^>]*" + "\\" + "bsrc=)[^>]*>([" + "\\" + "s" + "\\" + "S]*?)<" + "\\" + "/script>", "g");
  const out: string[] = [];
  for (const m of html.matchAll(INLINE_SCRIPT))
    out.push("'sha256-" + createHash("sha256").update(m[1], "utf8").digest("base64") + "'");
  return out.join(" ");
}
let CSP = "";
{
  const html = await readFile(pathResolve(PUBLIC, "index.html"), "utf8");
  CSP = [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes(html)}`.trim(),
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: https:",              // 표지는 남의 CDN 에서 온다
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/* ── 서버 ─────────────────────────────────────────────────── */
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  res.setHeader("Content-Security-Policy", CSP);
  try {
    if (await auth(req, res, url)) return;

    /* 공유로 들어온 것을 받는 자리. **문은 셋이지만 자리는 하나다** — 브라우저의 웹 공유
       대상, iOS 「단축어」, 안드로이드 앱이 모두 여기로 온다. 담을지 말지는 intakeShared 가
       혼자 정한다.

       **누구인지 아는 길이 둘이다.** 브라우저는 쿠키를 들고 오고, 브라우저 밖에서는 공유
       열쇠를 Authorization 에 얹어 온다. 열쇠를 먼저 본다 — 열쇠를 들고 왔다는 것은 그
       사람으로 담아 달라는 뜻이라, 마침 같은 기기 브라우저에 남의 쿠키가 남아 있어도
       열쇠가 이긴다.

       **답도 문에 따라 다르다.** 브라우저에는 화면을 띄워 줘야 하니 넘겨보내고(303),
       열쇠 쪽에는 띄울 화면이 없으니 JSON 으로 답한다. 담지 못했을 때 무엇을 열면 되는지
       (open) 까지 적어 주므로, 단축어는 그 주소를 열기만 하면 된다. */
    if (url.pathname === "/share" && req.method === "POST") {
      const body = await new Promise<string>(ok => {
        let b = ""; req.on("data", c => { b += c; }); req.on("end", () => ok(b));
      });
      const f = new URLSearchParams(body);
      const raw = f.get("url") || f.get("text") || f.get("title") || "";

      /* **303 이다.** 여기 오는 것은 POST 라, 302 로 답하면 브라우저에 따라 「같은 방법으로
         다시 가라」로 읽고 POST 를 한 번 더 보낸다 — 같은 것이 두 번 담긴다. 303 은
         「이제 GET 으로 가서 보라」는 뜻이라 그럴 자리가 없다. 그래서 두루 쓰는
         redirect(302) 를 쓰지 않는다. */
      const seeOther = (to: string) => { res.writeHead(303, { Location: to }); res.end(); };

      const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? null;
      const byKey = shareKeyUser(bearer);
      const ask = raw ? `/?text=${encodeURIComponent(raw)}` : "/";

      /* **열쇠를 들고 왔으면 그 열쇠로만 판단한다.** 안 통한다고 쿠키로 물러서면 안 된다 —
         남의 기기에 남아 있던 쿠키나, 로그인이 설정되지 않은 서버가 자동으로 내주는 계정에
         조용히 담기게 된다. 담긴 사람도, 보낸 사람도 그 사실을 모른다.

         안 통하면 안 통한다고 말해 준다. 브라우저 밖에서는 「조용히 아무 일도 안 일어남」이
         가장 고치기 어려운 고장이다 — 화면이 없으니 물어볼 데가 없다. */
      /* **글로만 답하기.** 받는 쪽에 화면이 없으면 동작 하나가 곧 틀릴 자리 하나다 —
         iOS 「단축어」에서 답을 받아 사전에서 값을 꺼내는 그 한 동작이 그렇다. fmt=text 면
         띄울 한 줄만 글로 보낸다. 그러면 「보내고 → 알림」 두 동작으로 끝난다.
         안드로이드 앱은 이 칸을 안 보내므로 지금처럼 JSON 을 받는다(open 이 필요하다). */
      const asText = f.get("fmt") === "text";
      const line = (code: number, msg: string) => {
        res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(msg);
      };

      if (bearer && !byKey) {
        if (asText) { line(401, "공유 열쇠가 맞지 않습니다"); return; }
        json(res, 401, { ok: false, reason: "공유 열쇠가 맞지 않습니다." });
        return;
      }
      const user = byKey ?? currentUser(req);
      if (!user) { seeOther(ask); return; }

      const r = await intakeShared(user, raw);
      if (byKey) {
        /* **그대로 띄울 한 줄을 함께 준다**(text). 받는 쪽에는 화면이 없어서, 참·거짓을
           보고 문장을 짓게 하면 그 자리가 곧 틀리는 자리가 된다 — iOS 「단축어」의 조건문이
           특히 그렇다(참을 1 로도 true 로도 다룬다). 이 한 줄이면 조건 없이 알림만 내면 된다.

           일어난 일의 이름은 여기서 짓는다. 가는 길에 생긴 일(못 닿았다·열쇠가 틀렸다)은
           받는 쪽이 짓는다 — 그건 서버가 알 수 없는 것들이다. */
        const text = r.kind === "saved"
          ? `${r.title} — ${r.made ? "담았습니다" : "이미 있습니다"}`
          : r.kind === "ask" ? "제목을 읽지 못했습니다 — 앱에서 확인하세요"
            : "보낼 주소가 없습니다";
        if (asText) { line(200, text); return; }
        json(res, 200, r.kind === "saved"
          ? { ok: true, saved: true, title: r.title, made: r.made, text }
          : { ok: true, saved: false, open: BASE_URL + (r.kind === "ask" ? ask : "/"), text });
        return;
      }
      /* 만든 것과 고친 것은 다른 일이다 — 화면이 다른 말을 하도록 함께 넘긴다
         (등록 화면의 토스트와 같은 규칙). */
      seeOther(r.kind === "saved"
        ? `/?saved=${encodeURIComponent(r.title)}${r.made ? "" : "&again=1"}`
        : r.kind === "ask" ? ask : "/");
      return;
    }

    // 로그인 화면이 어떤 버튼을 그릴지 알려준다 — 인증 없이 열려 있어야 한다
    if (url.pathname === "/api/auth/providers") {
      json(res, 200, { providers: availableProviders(), localFallback: localFallbackAllowed(),
        password: true });
      return;
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
      destroySession(readCookie(req.headers.cookie, COOKIE));
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const user = currentUser(req);
      if (!user) { json(res, 401, { ok: false, reason: "로그인이 필요합니다." }); return; }

      if (url.pathname === "/api/account" && req.method === "DELETE") {
        deleteUser(user.id);
        destroySession(readCookie(req.headers.cookie, COOKIE));
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (await api(req, res, url, user)) return;
      json(res, 404, { ok: false, reason: "없는 경로입니다." });
      return;
    }
    /* 올린 표지. public 이 아니라 data 아래에 있으므로 따로 내준다.
       이름은 우리가 지은 <작품id>.<확장자> 뿐이라 그 모양만 받는다 — 경로를 타고
       올라가는 이름(../)은 애초에 이 검사를 통과하지 못한다. */
    if (url.pathname.startsWith("/covers/")) {
      const name = url.pathname.slice("/covers/".length);
      if (/^[A-Za-z0-9_-]+\.(jpg|png|webp)$/.test(name)) {
        try {
          const body = await readFile(pathResolve(COVERS, name));
          res.writeHead(200, {
            "Content-Type": { jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[
              name.split(".").pop() as string]!,
            "Content-Length": body.length,
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          res.end(body);
          return;
        } catch { /* 없으면 아래로 흘러 404 */ }
      }
    }

    if (await serveStatic(req, res, url.pathname)) return;
    // SPA 폴백 — 공유 대상(/?url=...)도 index.html이 받는다
    if (await serveStatic(req, res, "/index.html")) return;
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("찾을 수 없습니다");
  } catch (err) {
    json(res, 500, { ok: false, reason: (err as Error).message });
  }
});

/* ── 시한부 표지를 되받는다 ──────────────────────────────────

   인스타그램이나 CloudFront 가 주는 표지 주소에는 서명과 만료가 박혀 있다. 차단당해서가
   아니라 **원래 그렇게 설계되어** 며칠이면 깨진다. 그런 것만 골라 조용히 다시 받아 온다.

   **전부 돌지 않는다.** 멀쩡한 주소까지 주기적으로 확인하면 남의 서버를 쉼 없이 두드리게
   되고, 그건 우리가 피하려던 바로 그 일이다. 지금 이 서버가 남의 사이트를 부르는 일은
   「누가 처음 담을 때」뿐이고, 여기가 두 번째다 — 그래서 작게 유지한다.

   지키는 것 넷:
     · **표지만** 고친다. 제목까지 고치면 직접 안 고친 사람 전부의 목록에서 이름이 하룻밤에 바뀐다.
     · **확실할 때만** 고친다(og 를 제대로 읽었고, 대문 정보가 아닐 때).
     · **못 읽었으면 그대로 둔다.** 있던 표지를 지우면 있던 것마저 사라진다.
     · **천천히** 한다. 한 건 하고 쉰다 — 몰아치면 그것이 곧 차단당하는 길이다.

   서버가 꺼지면 함께 꺼진다. 지금 규모에서는 그게 맞다 — 컨테이너 하나로 끝난다. */
const REFRESH_EVERY = 6 * 60 * 60 * 1000;   // 여섯 시간마다 한 차례
const REFRESH_AFTER = 3 * 24 * 60 * 60 * 1000;   // 받아 둔 지 사흘 지난 것
const REFRESH_MAX = 40;                      // 한 차례에 이만큼까지
const REFRESH_GAP = 1500;                    // 한 건 사이에 쉬는 시간

async function refreshStaleCovers(): Promise<void> {
  const list = staleCovers(REFRESH_AFTER, REFRESH_MAX);
  if (!list.length) return;
  let fixed = 0, checked = 0;
  for (const row of list) {
    await new Promise(r => setTimeout(r, REFRESH_GAP));
    try {
      const r = await resolveUrl(row.listUrl);       // 여기서는 아는 것을 쓰면 안 된다 — 새로 받아야 한다
      if (r.ok && !r.dead && r.origin === "og" && r.coverUrl) {
        refreshCover(row.id, r.coverUrl, r.coverAspect);
        fixed++;
      } else {
        markChecked(row.id);                         // 못 얻었으면 표지는 그대로, 본 때만 적는다
      }
    } catch { markChecked(row.id); }
    checked++;
  }
  console.log(`  시한부 표지 ${checked}건 확인 · ${fixed}건 새로 받음`);
}

server.listen(PORT, () => {
  console.log(`HabHobby → http://localhost:${PORT}`);
  const users = (db.prepare("SELECT COUNT(*) c FROM user").get() as { c: number }).c;
  const provs = availableProviders().map(p => p.id);
  const off = configuredProviders().filter(p => !provs.includes(p.id)).map(p => p.id);
  /* 「로컬 계정으로 동작」은 **정말 그럴 때만** 적는다. 꺼 둔 것이 있을 뿐이면
     자격 증명은 남아 있어 대체 계정이 열리지 않는다 — 여기서 거짓을 적으면
     운영하는 사람이 열려 있는 줄 알고 지나친다. */
  const how = provs.length ? provs.join(", ")
    : localFallbackAllowed() ? "미설정 (로컬 계정으로 동작)"
      : "아이디 로그인만";
  console.log(`  가입 ${users}명 · 로그인 ${how}` + (off.length ? ` · 꺼 둠 ${off.join(", ")}` : ""));

  /* 켜자마자 돌리지 않는다 — 다시 시작하는 일이 잦으면 그때마다 남의 서버를 두드리게 된다.
     한 시간 뒤에 첫 차례를 두고, 그 뒤로는 여섯 시간마다. */
  const tick = () => { refreshStaleCovers().catch(e => console.log("  표지 되받기 실패:", e?.message)); };
  setTimeout(() => { tick(); setInterval(tick, REFRESH_EVERY); }, 60 * 60 * 1000).unref();
});
