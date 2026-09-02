/* HTTP 서버 — 의존성 없이 node:http만 쓴다.
   API + 정적 파일 + PWA 공유 대상(share target)을 한 프로세스가 담당한다. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { copyFile, readFile, stat, writeFile, unlink } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, normalize, resolve as pathResolve } from "node:path";
import {
  db, kvGet, kvSet, listWorks, getWork, setWorkFolders, listFolders, newId,
  deleteUser, upsertUser, listFriends, countFriends, starFriend, contributedWorks,
  addFriend, removeFriend, areFriends,
  createGuest, linkGuest, isGuest,
  createPasswordUser, passwordUser, linkGuestPassword, markLogin,
  sharedView, createInvite, inviteOwner, getUser, setFolderShare, setFolderTake,
  getFolder, createFolder, canCopy, canMirror, canEdit, seenByMe, markSeen,
  folderInvites, acceptFolder, declineFolder, leaveFolder,
  noticeBreak, folderNotices, readNotices, sweepNotices, inviteToFolder, unlinkFromFolder,
  cleanName, setDisplayName, starFolder,
  type Work, type User, type ShareMode, type TakeMode,
} from "./db.ts";
import {
  PROVIDERS, configuredProviders, availableProviders, startLogin, completeLogin, createSession,
  userFromToken, destroySession, cookieHeader, readCookie, COOKIE,
  localFallbackAllowed, redirectUri, BASE_URL,
  hashPassword, verifyPassword, validLoginId, validPassword,
} from "./auth.ts";
import { PLATFORMS, platformById, readableOn, DOMAIN_PREFIX, registrableDomain } from "./platforms.ts";
import { resolveUrl, originLabel, fetchSiteName } from "./resolve.ts";

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
type Settings = { openMode: "app" | "web"; themeColor: string | null };
type Override = { name?: string; initial?: string; color?: string; fg?: string };
/* 마크 글자색은 배경에 맞춰 저절로 정해지지만, 경계에 걸친 색에서는 사람 눈에
   반대쪽이 나을 때가 있다 — 그래서 흰색·검정 둘 중에 직접 고를 수도 있다. */
const FG_CHOICES = ["#FFFFFF", "#1B1B1B"];
const normFg = (v: unknown): string | undefined => {
  const u = typeof v === "string" ? v.toUpperCase() : "";
  return FG_CHOICES.includes(u) ? u : undefined;
};

const getSettings = (u: string): Settings =>
  ({ openMode: "app", themeColor: null, ...kvGet<Partial<Settings>>(u, "settings", {}) });
const getOverrides = (u: string): Record<string, Override> => kvGet<Record<string, Override>>(u, "overrides", {});
/* 사이트가 스스로 밝힌 이름(og:site_name). 빈 문자열은 "받아봤지만 없더라"는 표시다 —
   키가 있으면 다시 묻지 않으므로 실패한 사이트를 접속할 때마다 두드리지 않는다. */
const getSiteNames = (u: string): Record<string, string> => kvGet<Record<string, string>>(u, "siteNames", {});
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
  auto: Record<string, string>;
  hosts: Map<string, string[]>;
};

function platformCtx(userId: string): PlatCtx {
  const rows = db.prepare("SELECT platform_id, list_url FROM work WHERE user_id = ?")
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
  return { ov: getOverrides(userId), auto: getSiteNames(userId), hosts };
}

function hostsIn(userId: string, platformId: string): string[] {
  return platformCtx(userId).hosts.get(platformId) ?? [];
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
function pendingSiteNames(userId: string): { id: string; host: string }[] {
  const names = getSiteNames(userId), out: { id: string; host: string }[] = [];
  for (const w of listWorks(userId)) {
    if (!w.platformId.startsWith(DOMAIN_PREFIX) || w.platformId in names) continue;
    if (out.some(x => x.id === w.platformId)) continue;
    out.push({ id: w.platformId, host: w.platformId.slice(DOMAIN_PREFIX.length) });
  }
  return out;
}

/** 클라이언트가 보낸 일정을 저장 가능한 모양으로 맞춘다.
    빠진 칸이 있으면 SQLite 바인딩에서 죽으므로 여기서 막는다. */
function normSchedule(v: any) {
  const s = v ?? {};
  return {
    mode: typeof s.mode === "string" ? s.mode : "unknown",
    days: Array.isArray(s.days) ? s.days.filter((n: any) => Number.isInteger(n)) : [],
    next: typeof s.next === "number" ? s.next : null,
    source: s.source === "auto" ? "auto" : "user",
  };
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
  /* **살아 있는 것만 담는다.** 휴지통이나 감상 완료에 내려둔 작품이 여기 끼어 있으면,
     그것이 친구 줄을 밀어내 놓고 저는 화면에서 걸러진다(폴더는 active 만 세운다) —
     친구 폴더에는 멀쩡히 있는데 내 쪽에서만 조용히 사라지는 구멍이 난다.

     못 본 척하는 것이 옳다: 내가 내 목록에서 내려둔 것은 **내 목록의 결정**이지,
     친구 폴더를 어떻게 볼지의 결정이 아니다. 되돌리면 다시 여기 들어와 제자리를 찾는다. */
  const mineByKey = new Map<string, any>(
    works.filter(w => w.state === "active").map(w => [keyOf(w), w]));

  /** 남의 작품 한 줄을 내 목록에 놓을 모양으로 바꾼다 */
  const asGuest = (w: any, folderId: string, owner: string, who: string,
                   take: string, folderOnly: boolean) => {
    const mark = seen.get(w.id);
    return { ...w, folders: [folderId], filed: true,
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
function upsertWork(userId: string, input: {
  platformId: string; seriesId: string; title: string; mediaType: string;
  listUrl: string; appUrl: string | null; coverUrl: string | null; coverAspect: number | null;
  episode: string | null;
  schedule: { mode: string; days: number[]; next: number | null; source: string };
  folders: string[]; filed: boolean; color?: string | null;
}): Work {
  const now = Date.now();
  /* **살아 있는 것만 본다.** 휴지통에 같은 작품이 있어도 새로 만든다 — 내려둔 것과
     새로 담는 것은 별개다. 예전에는 여기서 찾아내 state='active' 로 되살렸는데,
     그러면 그때 매겨 둔 별점과 폴더가 딸려 와 "새로 담았다" 와 다른 것이 생겼다.
     살아 있는 것끼리의 중복은 여전히 막는다. */
  const existing = db.prepare(
    "SELECT id FROM work WHERE user_id = ? AND platform_id = ? AND series_id = ? AND state = 'active'")
    .get(userId, input.platformId, input.seriesId) as { id: string } | undefined;

  if (existing) {
    db.prepare(`UPDATE work SET title = ?, cover_url = COALESCE(?, cover_url),
        cover_aspect = COALESCE(?, cover_aspect),
        episode = COALESCE(?, episode), last_at = ?, state = 'active'
      WHERE id = ?`)
      .run(input.title, input.coverUrl, input.coverAspect, input.episode, now, existing.id);
    if (input.folders.length) {
      const cur = getWork(userId, existing.id)!.folders;
      setWorkFolders(userId, existing.id, [...new Set([...cur, ...input.folders])]);
    }
    return getWork(userId, existing.id)!;
  }

  const id = newId("w");
  db.prepare(`INSERT INTO work
      (id, user_id, platform_id, series_id, title, media_type, list_url, app_url, cover_url,
       cover_aspect, episode, state, filed, visits, last_at, added_at,
       sched_mode, sched_days, sched_next, sched_source, sched_from, color)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, 'active', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, input.platformId, input.seriesId, input.title, input.mediaType,
      input.listUrl, input.appUrl, input.coverUrl, input.coverAspect, input.episode,
      input.filed || input.folders.length ? 1 : 0, now, now,
      input.schedule.mode, JSON.stringify(input.schedule.days),
      input.schedule.next, input.schedule.source, now, input.color ?? null);
  if (input.folders.length) setWorkFolders(userId, id, input.folders);
  return getWork(userId, id)!;
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
  /* 살아 있는 것만 본다 — upsertWork 와 같은 잣대다. 휴지통에 내려둔 것이 있다고
     담아가기가 막히면, 화면에는 「이미 담겨 있습니다」라는데 어디에도 안 보인다. */
  const had = db.prepare(
    "SELECT id FROM work WHERE user_id = ? AND platform_id = ? AND series_id = ? AND state = 'active'")
    .get(userId, src.platformId, src.seriesId) as { id: string } | undefined;

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
  db.prepare(`INSERT INTO work
      (id, user_id, platform_id, series_id, title, media_type, list_url, app_url, cover_url,
       cover_aspect, episode, state, filed, visits, last_at, added_at,
       sched_mode, sched_days, sched_next, sched_source, sched_from, color)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, 'active', 1, 0, ?, ?, ?, ?, ?, ?, ?, NULL)`)
    .run(id, userId, src.platformId, src.seriesId, src.title, src.mediaType,
      src.listUrl, src.appUrl, cover, src.coverAspect, src.episode, now, now,
      src.schedule.mode, JSON.stringify(src.schedule.days),
      src.schedule.next, src.schedule.source, now);
  if (folderIds.length) setWorkFolders(userId, id, folderIds);
  return { already: false, id };
}

/* ── 라우팅 ───────────────────────────────────────────────── */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
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
    const r = await resolveUrl(String(target ?? ""));
    json(res, r.ok ? 200 : 400, r.ok ? { ...r, originLabel: originLabel(r) } : r);
    return true;
  }

  if (p === "/api/works" && m === "POST") {
    const b = await readJson(req);

    /* 주소 없이 제목만으로 담기. 개봉을 기다리는 영화처럼 아직 페이지가 없는 것들이 있다.
       시리즈 식별자를 새로 만들어 주므로 같은 제목을 여러 번 담아도 서로 덮지 않는다. */
    if (!String(b.url ?? "").trim()) {
      const title = String(b.title ?? "").trim();
      if (!title) { json(res, 400, { ok: false, reason: "제목이 필요합니다." }); return true; }
      const work = upsertWork(user.id, {
        platformId: "note", seriesId: newId("n"), title, mediaType: "link",
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

    const r = await resolveUrl(String(b.url ?? ""));

    /* **없는 페이지는 담지 않는다.** 여기서 막는 것은 「없다고 확신할 수 있는 것」뿐이다 —
       그쪽이 404 라 했거나, 깊은 주소를 물었는데 대문으로 튕겼거나(없는 작품 번호),
       받아온 것이 그 작품 이야기가 아니라 대문 정보이거나.

       못 읽은 것(403·시간 초과)은 막지 않는다. 사람이 눈으로 보고 온 페이지를 우리가
       못 읽었다고 거절하면 안 된다 — CGV 가 그렇다. 그쪽은 화면에서 경고만 한다. */
    /* **generic 은 막지 않는다.** 그건 「없다」가 아니라 「우리가 못 읽었다」이다 —
       카카오페이지는 화면을 브라우저에서 그려서 어느 작품 주소든 같은 대문 태그를 주고,
       네이버 지도도 그렇다. 멀쩡한 페이지라 사람이 제목을 직접 적어 담으면 되는데,
       여기서 막으면 그 플랫폼이 통째로 담을 수 없게 된다(실제로 두 곳이 걸렸다). */
    if (r.ok && r.dead && r.dead !== "generic") {
      json(res, 400, { ok: false, dead: r.dead, reason:
        r.dead === "notfound" ? "그 주소에 페이지가 없습니다. 주소를 다시 확인해 주세요."
          : r.dead === "moved" ? "그 작품을 찾을 수 없습니다 — 주소가 대문으로 넘어갑니다."
            : r.dead === "generic" ? "그 페이지에서 작품 정보를 찾지 못했습니다. 작품 페이지 주소가 맞나요?"
            : "그런 주소가 없습니다. 도메인을 다시 확인해 주세요." });
      return true;
    }
    if (!r.ok) { json(res, 400, r); return true; }
    const title = String(b.title ?? r.title ?? "").trim();
    if (!title) { json(res, 400, { ok: false, reason: "제목이 필요합니다." }); return true; }
    const platformId = applyMerge(user.id, r.platform.id);
    const hex = (v: unknown) =>
      typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
    const work = upsertWork(user.id, {
      platformId, seriesId: r.seriesId, title, mediaType: r.mediaType,
      listUrl: r.listUrl, appUrl: r.appUrl, coverUrl: r.coverUrl,
      coverAspect: r.coverAspect, episode: r.episode,
      schedule: b.schedule ? normSchedule(b.schedule) : r.schedule,
      folders: Array.isArray(b.folders) ? b.folders : [],
      filed: !!b.filed, color: hex(b.color),
    });
    /* 구간 이름은 여기서 정하지 않는다. 이 페이지가 밝힌 og:site_name 을 믿었더니
       교보문고 전자책 페이지가 "IMDb" 라고 답하는 일이 있었다 — 남의 메타 태그를 그대로
       베껴 둔 것이다. 사이트 이름은 대문에 물어보는 게 맞고, 그건 site-names 가 한다. */
    json(res, 201, { ok: true, work });
    return true;
  }

  /* 이미 쌓인 도메인들의 이름을 뒤늦게 채운다. 한 번에 몇 개씩만 — 한 사이트당 한 번이면 된다. */
  if (p === "/api/platforms/site-names" && m === "POST") {
    const todo = pendingSiteNames(user.id);
    const batch = todo.slice(0, 6);
    const got = await Promise.all(batch.map(async t =>
      [t.id, await fetchSiteName(t.host).catch(() => ({ read: false, name: null }))] as const));
    const names = getSiteNames(user.id);
    // 못 읽었어도 표시는 남긴다. 안 그러면 같은 사이트를 끝없이 다시 묻는다 —
    // 다시 시도할 길은 편집 화면의 "가져오기"로 열어 두었다.
    for (const [id, r] of got) names[id] = r.name ?? "";
    kvSet(user.id, "siteNames", names);
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
    const rows = db.prepare("SELECT id, list_url FROM work WHERE user_id = ? AND platform_id = ?")
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
    const names = getSiteNames(user.id);
    const got = await fetchSiteName(host).catch(() => ({ read: false, name: null }));
    if (got.read) names[target] = got.name ?? "";
    else delete names[target];        // 못 읽었으면 표시를 남기지 않아 나중에 다시 묻는다
    kvSet(user.id, "siteNames", names);

    json(res, 200, { ok: true, moved, platform: platformView(user.id, target) });
    return true;
  }

  /* 한 도메인의 이름을 사이트에 다시 물어본다 — 편집 화면의 "가져오기" */
  if (seg[0] === "api" && seg[1] === "platforms" && seg[2] && seg[3] === "site-name" && m === "POST") {
    const pid = decodeURIComponent(seg[2]);
    if (!pid.startsWith(DOMAIN_PREFIX)) { json(res, 400, { ok: false, reason: "도메인 묶음이 아닙니다." }); return true; }
    const r = await fetchSiteName(pid.slice(DOMAIN_PREFIX.length))
      .catch(() => ({ read: false, name: null }));
    if (!r.read) { json(res, 200, { ok: false, reason: "사이트를 읽지 못했습니다." }); return true; }
    const names = getSiteNames(user.id);
    names[pid] = r.name ?? "";
    kvSet(user.id, "siteNames", names);
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
      if (!w) { json(res, 404, { ok: false, reason: "없는 작품입니다." }); return true; }
      if (b.schedule) {
        // 일정을 새로 정하면 그 시점부터 적용된다 — 과거 요일까지 소급하지 않는다
        db.prepare(`UPDATE work SET sched_mode=?, sched_days=?, sched_next=?,
            sched_source='user', sched_from=? WHERE id=?`)
          .run(b.schedule.mode ?? w.schedule.mode,
            JSON.stringify(b.schedule.days ?? w.schedule.days),
            b.schedule.next ?? null, Date.now(), id);
      }
      if (typeof b.title === "string" && b.title.trim())
        db.prepare("UPDATE work SET title=? WHERE id=?").run(b.title.trim(), id);
      // 언제 내렸는지 남긴다 — 캘린더에 "보던 기간" 을 그리는 데 쓴다
      if (typeof b.state === "string" && ["active", "watched", "dropped"].includes(b.state))
        db.prepare("UPDATE work SET state=?, state_at=? WHERE id=?").run(b.state, Date.now(), id);
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
      json(res, 200, { ok: true, work: getWork(user.id, id) });
      return true;
    }
    if (m === "DELETE") {
      // 남의 것을 지우려 하면 아무 행도 안 지워진다. 그때 200을 주면 지운 것처럼 보인다.
      // 올려 둔 표지도 함께 지운다 — 안 그러면 주인 없는 파일만 쌓인다
      for (const ext of ["jpg", "png", "webp"])
        await unlink(pathResolve(COVERS, `${id}.${ext}`)).catch(() => {});
      const rw = db.prepare("DELETE FROM work WHERE id = ? AND user_id = ?").run(id, user.id);
      if (!rw.changes) { json(res, 404, { ok: false, reason: "없는 작품입니다." }); return true; }
      json(res, 200, { ok: true });
      return true;
    }
  }

  /* 공개 대상과 퍼가기 권한을 받아 담는다. 만들 때와 고칠 때가 같은 값을 받으므로
     받아들이는 잣대도 한 곳에 둔다.

     공개 대상은 **실제 친구만** 받는다. 친구가 아닌 사람의 아이디를 끼워 넣어도 저장되지
     않게 여기서 거른다 — 지우는 쪽이 아니라 담는 쪽에서 막는 것이 안전하다. */
  const applyShare = (id: string, b: any) => {
    if (b.share && ["none", "all", "some"].includes(b.share.mode) && !isGuest(user)) {
      const want: string[] = Array.isArray(b.share.with)
        ? b.share.with.filter((x: any) => typeof x === "string") : [];
      /* 함께 고치는 폴더는 **부른다고 곧바로 참여자가 되지 않는다** — 수락을 받는다.
         퍼가기 값이 이번에 함께 왔으면 그것을, 아니면 지금 폴더에 적힌 것을 본다. */
      const take = ["none", "copy", "mirror", "both", "edit"].includes(b.take)
        ? b.take : getFolder(user.id, id)?.take;
      setFolderShare(id, b.share.mode as ShareMode, want.filter(v => areFriends(user.id, v)),
        take === "edit");
    }
    /* 퍼가기 권한 — 공개하지 않은 폴더에는 뜻이 없지만, 껐다 켰다 할 때마다 값이
       날아가면 다시 정해야 하므로 공개 여부와 상관없이 그대로 담아 둔다. */
    if (["none", "copy", "mirror", "both", "edit"].includes(b.take)) setFolderTake(id, b.take as TakeMode);
  };

  if (p === "/api/folders" && m === "POST") {
    const b = await readJson(req);
    const name = String(b.name ?? "").trim();
    if (!name) { json(res, 400, { ok: false, reason: "폴더 이름이 필요합니다." }); return true; }
    const { id } = createFolder(user.id, { name, emoji: String(b.emoji ?? "") });
    applyShare(id, b);
    json(res, 201, { ok: true, folder: getFolder(user.id, id) });
    return true;
  }

  /* 표지 올리기. 몸통은 그림 바이트 그대로다 — 개인용 한 파일짜리 업로드에
     multipart 를 끌어들일 이유가 없다. 형식과 크기는 여기서 가른다. */
  if (seg[1] === "works" && seg[3] === "cover" && m === "PUT") {
    const id = seg[2];
    const w = getWork(user.id, id);
    if (!w) { json(res, 404, { ok: false, reason: "없는 작품입니다." }); return true; }

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
    // 비추는 폴더는 내가 고칠 것이 없다 — 이름도 아이콘도 주인 것이다
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

    if (mine?.mirror && m === "PATCH") {
      json(res, 403, { ok: false, reason: "비추는 폴더는 고칠 수 없습니다." });
      return true;
    }
    if (m === "PATCH") {
      if (!mine) { json(res, 404, { ok: false, reason: "없는 폴더입니다." }); return true; }
      const b = await readJson(req);

      db.prepare("UPDATE folder SET name = COALESCE(?, name), emoji = COALESCE(?, emoji) WHERE id = ?")
        .run(b.name?.trim() || null, b.emoji || null, id);

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
      let n = 0;
      for (const wid of new Set(want)) {
        const w = getWork(user.id, wid);          // 내 작품만 — 남의 것은 여기서 걸린다
        if (!w || w.folders.includes(into)) continue;
        setWorkFolders(user.id, wid, [...w.folders, into]);
        // mayFile 이 막았으면 늘지 않는다 — 넣었다고 답하지 않으려고 다시 센다
        if (getWork(user.id, wid)!.folders.includes(into)) n++;
      }
      json(res, 200, { ok: true, added: n });
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
        if (!src) { json(res, 403, { ok: false, reason: "담아갈 수 없는 작품입니다." }); return true; }
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
    // 테마 색 — #rrggbb 만 받는다. null 이면 기본으로 되돌린다.
    if (b.themeColor === null) next.themeColor = null;
    else if (typeof b.themeColor === "string" && /^#[0-9a-fA-F]{6}$/.test(b.themeColor))
      next.themeColor = b.themeColor.toLowerCase();
    kvSet(user.id, "settings", next);
    json(res, 200, { ok: true, settings: next });
    return true;
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

/* ── 서버 ─────────────────────────────────────────────────── */
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (await auth(req, res, url)) return;

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
});
