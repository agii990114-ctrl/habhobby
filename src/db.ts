/* SQLite 스키마와 접근 계층. 의존성 없이 Node 내장 node:sqlite를 쓴다.

   모든 사용자 데이터는 user_id로 격리된다. 조회 함수가 전부 userId를 받도록 만들어,
   깜빡하고 남의 데이터를 섞어 내보내는 일이 타입 단계에서 걸리게 했다. */
import { DatabaseSync } from "node:sqlite";
import { DOMAIN_PREFIX } from "./platforms.ts";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DB_PATH = resolve(process.cwd(), "data/habhobby.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

export const LOCAL_USER = "u_local";   // 로그인 도입 전에 쌓인 데이터의 주인

/* ── 로그인 이전 데이터 이관 ──────────────────────────────────
   예전 스키마에는 user_id가 없었다. 남아 있으면 로컬 계정에 붙여 살린다. */
function migrateSingleUser(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_uid TEXT NOT NULL,
    email TEXT, name TEXT, avatar TEXT,
    created_at INTEGER NOT NULL, last_login_at INTEGER NOT NULL,
    UNIQUE (provider, provider_uid))`);
  const legacy = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='work_legacy'").get();
  if (legacy) return;

  const cols = db.prepare("PRAGMA table_info(work)").all() as { name: string }[];
  if (!cols.length) return;   // 빈 DB — 아래 CREATE가 처음부터 새 스키마로 만든다
  if (cols.some(c => c.name === "user_id")) return;   // 이미 새 스키마 = 이관할 것 없음

  // 여기 오면 예전 테이블이 그대로다. 위 CREATE는 IF NOT EXISTS라 건드리지 않았다.
  db.exec("BEGIN");
  try {
    const now = Date.now();
    db.prepare(`INSERT OR IGNORE INTO user
        (id, provider, provider_uid, email, name, avatar, created_at, last_login_at)
      VALUES (?, 'local', 'local', NULL, '이 기기', NULL, ?, ?)`)
      .run(LOCAL_USER, now, now);

    db.exec("ALTER TABLE work   RENAME TO work_legacy");
    db.exec("ALTER TABLE folder RENAME TO folder_legacy");
    db.exec("ALTER TABLE kv     RENAME TO kv_legacy");
    db.exec("DROP INDEX IF EXISTS idx_work_state");
    db.exec("ALTER TABLE work_folder RENAME TO work_folder_legacy");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function copyLegacy(): void {
  const has = (t: string) => !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (!has("work_legacy")) return;

  const old = db.prepare("PRAGMA table_info(work_legacy)").all() as { name: string }[];
  const names = new Set(old.map(c => c.name));
  const pick = (c: string, d = "NULL") => (names.has(c) ? c : d);

  db.exec("BEGIN");
  try {
    db.exec(`INSERT OR IGNORE INTO work
        (id, user_id, platform_id, series_id, title, media_type, list_url, app_url,
         cover_url, cover_aspect, episode, state, filed, visits, last_at, added_at,
         sched_mode, sched_days, sched_next, sched_source)
      SELECT id, '${LOCAL_USER}', platform_id, series_id, title, media_type, list_url, app_url,
             ${pick("cover_url")}, ${pick("cover_aspect")}, ${pick("episode")},
             ${pick("state", "'active'")}, ${pick("filed", "0")}, ${pick("visits", "0")},
             last_at, added_at, sched_mode, sched_days, sched_next, sched_source
      FROM work_legacy`);
    db.exec(`INSERT OR IGNORE INTO folder (id, user_id, name, emoji, ord)
      SELECT id, '${LOCAL_USER}', name, emoji, ord FROM folder_legacy`);
    db.exec(`INSERT OR IGNORE INTO work_folder (work_id, folder_id)
      SELECT work_id, folder_id FROM work_folder_legacy`);
    db.exec(`INSERT OR IGNORE INTO kv (user_id, k, v)
      SELECT '${LOCAL_USER}', k, v FROM kv_legacy`);
    db.exec("DROP TABLE work_folder_legacy");
    db.exec("DROP TABLE work_legacy");
    db.exec("DROP TABLE folder_legacy");
    db.exec("DROP TABLE kv_legacy");
    db.exec("COMMIT");
    const n = (db.prepare("SELECT COUNT(*) c FROM work WHERE user_id = ?")
      .get(LOCAL_USER) as { c: number }).c;
    console.log(`  이전 데이터 ${n}편을 로컬 계정으로 옮겼습니다.`);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}


// 옛 테이블을 먼저 비켜두어야 새 스키마와 인덱스가 만들어진다
migrateSingleUser();

db.exec(`
CREATE TABLE IF NOT EXISTS user (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,          -- kakao | naver | google | local
  provider_uid  TEXT NOT NULL,
  email         TEXT,
  name          TEXT,
  avatar        TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL,
  UNIQUE (provider, provider_uid)
);

-- 세션 토큰은 원문을 저장하지 않는다. DB가 새도 쿠키를 만들어낼 수 없어야 한다.
CREATE TABLE IF NOT EXISTS session (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua         TEXT
);

-- 로그인 왕복 사이의 일회용 상태 (CSRF 방지)
CREATE TABLE IF NOT EXISTS oauth_state (
  state      TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  verifier   TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS work (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  platform_id  TEXT NOT NULL,
  series_id    TEXT NOT NULL,
  title        TEXT NOT NULL,
  media_type   TEXT NOT NULL DEFAULT 'link',
  list_url     TEXT NOT NULL,
  app_url      TEXT,
  cover_url    TEXT,
  cover_aspect REAL,
  episode      TEXT,
  state        TEXT NOT NULL DEFAULT 'active',   -- active | watched | dropped
  filed        INTEGER NOT NULL DEFAULT 0,
  visits       INTEGER NOT NULL DEFAULT 0,
  last_at      INTEGER NOT NULL,
  added_at     INTEGER NOT NULL,
  sched_mode   TEXT NOT NULL DEFAULT 'unknown',
  sched_days   TEXT NOT NULL DEFAULT '[]',
  sched_next   INTEGER,
  sched_source TEXT NOT NULL DEFAULT 'auto',
  sched_from   INTEGER,                            -- 이 일정이 적용되기 시작한 시점
  rating       INTEGER,                            -- 1~5, 안 매겼으면 NULL
  state_at     INTEGER,                            -- state가 마지막으로 바뀐 때
  color        TEXT,                               -- 캘린더 점 색. 없으면 플랫폼 색
  UNIQUE (user_id, platform_id, series_id)
);

CREATE TABLE IF NOT EXISTS folder (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  emoji   TEXT NOT NULL DEFAULT '📁',
  ord     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS work_folder (
  work_id   TEXT NOT NULL REFERENCES work(id)   ON DELETE CASCADE,
  folder_id TEXT NOT NULL REFERENCES folder(id) ON DELETE CASCADE,
  PRIMARY KEY (work_id, folder_id)
);

CREATE TABLE IF NOT EXISTS kv (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  k       TEXT NOT NULL,
  v       TEXT NOT NULL,
  PRIMARY KEY (user_id, k)
);

-- 친구는 양방향이다. 두 줄로 저장해 조회를 단순하게 둔다.
CREATE TABLE IF NOT EXISTS friend (
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  friend_id  TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

-- 초대 링크. 아이디를 검색해 아무나 추가하는 방식을 쓰지 않으므로
-- 링크를 받은 사람만 친구가 될 수 있다.
CREATE TABLE IF NOT EXISTS invite (
  code       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- "이 폴더는 이 친구에게만" 을 담는다. 모두에게 공개하는 폴더는 여기 줄이 없다.
CREATE TABLE IF NOT EXISTS folder_share (
  folder_id TEXT NOT NULL REFERENCES folder(id) ON DELETE CASCADE,
  viewer_id TEXT NOT NULL REFERENCES user(id)   ON DELETE CASCADE,
  PRIMARY KEY (folder_id, viewer_id)
);

CREATE INDEX IF NOT EXISTS idx_work_user   ON work(user_id, state);
CREATE INDEX IF NOT EXISTS idx_folder_user ON folder(user_id);
CREATE INDEX IF NOT EXISTS idx_session_exp ON session(expires_at);
`);

copyLegacy();

db.exec("DROP TABLE IF EXISTS catalog; DROP TABLE IF EXISTS catalog_run;");

// 앱 안에서 쓰는 표시 이름. 로그인 제공자에게서 받아오지 않고 사용자가 직접 정한다 —
// 본명이 노출되지 않고, 제공자에게 프로필 권한을 요구하지 않아도 된다.
try { db.exec("ALTER TABLE user ADD COLUMN display_name TEXT"); } catch { /* 이미 있음 */ }
/* 아이디·비밀번호로 만든 계정. 카카오 같은 제공자를 거치지 않는 길이다.
   provider = 'password', provider_uid = 아이디. 비밀번호는 그대로 담지 않고 요약만 담는다. */
try { db.exec("ALTER TABLE user ADD COLUMN password_hash TEXT"); } catch { /* 이미 있음 */ }
// 폴더 단위 공개. 담아둔 것 전부가 아니라 사용자가 고른 폴더만 친구에게 보인다.
try { db.exec("ALTER TABLE folder ADD COLUMN shared INTEGER NOT NULL DEFAULT 0"); } catch { }
/* 공개 방식이 켬/끔 둘뿐이었는데, "이 친구에게만" 이 필요해져 세 갈래로 늘렸다.
   none(나만) · all(모든 친구) · some(고른 친구 — folder_share 에 짝이 있다).
   옛 shared 열은 읽지 않는다. 지우면 예전 판으로 되돌릴 수 없어 남겨 둔다. */
try {
  db.exec("ALTER TABLE folder ADD COLUMN share_mode TEXT NOT NULL DEFAULT 'none'");
  const n = db.prepare("UPDATE folder SET share_mode = 'all' WHERE shared = 1").run().changes;
  if (n) console.log(`  공개 폴더를 새 방식으로 옮김: ${n}개`);
} catch { /* 이미 있음 */ }
// 비워두면 added_at으로 대신한다 — 기존 작품은 등록 시점이 곧 일정 시작이다
try { db.exec("ALTER TABLE work ADD COLUMN sched_from INTEGER"); } catch { }
try { db.exec("ALTER TABLE work ADD COLUMN rating INTEGER"); } catch { }
try { db.exec("ALTER TABLE work ADD COLUMN state_at INTEGER"); } catch { }
try { db.exec("ALTER TABLE work ADD COLUMN color TEXT"); } catch { }
/* 자주 보는 친구에 별을 켠다. 친구 관계는 양쪽에 한 줄씩 담기므로 **내 줄에만** 켜면
   상대는 모르는 나만의 표시가 된다 — 서로 동의할 일이 아니라서 그래야 맞다. */
try { db.exec("ALTER TABLE friend ADD COLUMN starred INTEGER NOT NULL DEFAULT 0"); } catch { }
/* 공개한 폴더를 친구가 **가져갈 수 있는가**. 보는 것과 가져가는 것은 다른 일이다.
   none(보기만) · copy(담아가기) · mirror(미러링) · both.

   기본값을 copy 로 둔다 — 이 칸이 생기기 전에는 공개한 폴더를 담아갈 수 있었으므로,
   말없이 막아 버리면 어제까지 되던 것이 오늘 안 된다. 미러링은 새로 생긴 것이라
   주인이 직접 켜야 열린다. */
try { db.exec("ALTER TABLE folder ADD COLUMN take_mode TEXT NOT NULL DEFAULT 'copy'"); } catch { }
/* 남의 폴더를 비추고 있는 폴더. 둘 다 비어 있으면 내 폴더다.
   작품을 베껴 담지 않고 **읽을 때마다 주인 것을 그대로 가져다 보여 준다** —
   그래서 주인이 고치면 나에게도 바뀌고, 나는 고칠 수 없다. */
try { db.exec("ALTER TABLE folder ADD COLUMN mirror_owner  TEXT"); } catch { }
try { db.exec("ALTER TABLE folder ADD COLUMN mirror_folder TEXT"); } catch { }
/* 이미 내려둔 작품은 언제 내렸는지 모른다 — 마지막으로 연 때를 대신 쓴다.
   캘린더에 남길 구간의 끝을 정하는 값이라 비워두면 아예 안 보인다. */
db.prepare("UPDATE work SET state_at = last_at WHERE state != 'active' AND state_at IS NULL").run();

/* 한때 하위 도메인을 등록 단위로 합쳐 저장한 적이 있다. 기준을 호스트로 되돌렸으므로
   그때 옮겨진 항목을 제 호스트로 돌려놓는다. 원래 호스트는 list_url 에 남아 있다.

   사용자가 직접 합쳐 둔 것(domainMerges)은 그 사람의 판단이므로 건드리지 않는다. */
function restoreHostGrouping(): void {
  const rows = db.prepare(
    `SELECT id, user_id, platform_id, list_url FROM work WHERE platform_id LIKE '${DOMAIN_PREFIX}%'`)
    .all() as { id: string; user_id: string; platform_id: string; list_url: string }[];

  const mergesOf = new Map<string, Record<string, string>>();
  const upd = db.prepare("UPDATE OR IGNORE work SET platform_id = ? WHERE id = ?");
  let moved = 0;

  for (const r of rows) {
    let host: string;
    try { host = new URL(r.list_url).hostname.replace(/^www\./, "").replace(/^m\./, ""); }
    catch { continue; }

    if (!mergesOf.has(r.user_id)) {
      const row = db.prepare("SELECT v FROM kv WHERE user_id = ? AND k = 'domainMerges'")
        .get(r.user_id) as { v: string } | undefined;
      let m: Record<string, string> = {};
      if (row) try { m = JSON.parse(row.v); } catch { /* 깨진 값은 없는 셈 친다 */ }
      mergesOf.set(r.user_id, m);
    }
    const merges = mergesOf.get(r.user_id)!;
    const want = merges[DOMAIN_PREFIX + host] ?? DOMAIN_PREFIX + host;
    if (want === r.platform_id) continue;
    upd.run(want, r.id);
    moved++;
  }
  if (moved) console.log(`  도메인 구간을 호스트 기준으로 되돌림: ${moved}편`);
}
restoreHostGrouping();

/* 한때 작품 페이지가 밝힌 og:site_name 을 구간 이름으로 삼았는데, 남의 메타 태그를 베껴 둔
   페이지가 있어 엉뚱한 이름이 박혔다(교보문고 전자책 → "IMDb"). 이제 도메인 대문에만
   물어보므로, 그때 저장된 이름은 한 번 비워 다시 받게 한다. 사용자가 직접 지은 이름은
   overrides 에 따로 있으므로 영향이 없다. */
{
  // 한 번만 돌아야 하므로 DB 자체의 버전 칸을 쓴다. kv 는 사용자에 묶여 있어 표식을 둘 수 없다.
  const cur = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (cur < 1) {
    const n = db.prepare("DELETE FROM kv WHERE k = 'siteNames'").run().changes;
    db.exec("PRAGMA user_version = 1");
    if (n) console.log(`  구간 이름 재조회 예약: ${n}명분`);
  }
}

/* 줄바꿈과 들여쓰기를 og:title 에 그대로 넣어 둔 페이지가 있어, 제목에 공백이 수십 칸씩
   들어간 것들이 저장돼 있다. 이제 받을 때 줄이지만 이미 담긴 것은 여기서 편다. */
{
  const cur = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (cur < 2) {
    const rows = db.prepare("SELECT id, title FROM work").all() as { id: string; title: string }[];
    const upd = db.prepare("UPDATE work SET title = ? WHERE id = ?");
    let n = 0;
    for (const r of rows) {
      const t = r.title.replace(/\s+/g, " ").trim();
      if (t && t !== r.title) { upd.run(t, r.id); n++; }
    }
    db.exec("PRAGMA user_version = 2");
    if (n) console.log(`  제목의 군더더기 공백 정리: ${n}편`);
  }
}

/* 네이버웹툰 앱 스킴을 짐작으로 적어 두었던 때가 있다(naverwebtoon://). 그 주소로는
   앱이 열리지 않는다 — 이미 담긴 작품들의 주소도 바른 것으로 바꾼다. */
{
  const n = db.prepare(
    `UPDATE work SET app_url = 'webtoonkr://contentList?version=2&league=WEBTOON&titleId='
       || substr(app_url, length('naverwebtoon://contentList?titleId=') + 1)
     WHERE app_url LIKE 'naverwebtoon://contentList?titleId=%'`).run().changes;
  if (n) console.log(`  네이버웹툰 앱 주소 정리: ${n}편`);
}

/* 글(블로그) 매체에 회차를 붙여 저장하던 때가 있다. 그 자리에 담긴 건 회차가 아니라
   글 번호이므로 비운다. 매체를 보고 가르므로 플랫폼이 늘어도 그대로 적용된다. */
{
  const n = db.prepare("UPDATE work SET episode = NULL WHERE media_type = 'text' AND episode IS NOT NULL")
    .run().changes;
  if (n) console.log(`  글 매체의 회차 표기 정리: ${n}편`);
}


/* ── 사용자 ──────────────────────────────────────────────── */
export type User = {
  id: string; provider: string; providerUid: string;
  email: string | null; name: string | null; avatar: string | null;
  displayName: string | null;   // 친구에게 보이는 이름 (앱 안에서 직접 정함)
};

const toUser = (r: any): User => ({
  id: r.id, provider: r.provider, providerUid: r.provider_uid,
  email: r.email, name: r.name, avatar: r.avatar, displayName: r.display_name ?? null,
});

export function upsertUser(p: {
  provider: string; providerUid: string;
  email?: string | null; name?: string | null; avatar?: string | null;
}): User {
  const now = Date.now();
  const found = db.prepare("SELECT * FROM user WHERE provider = ? AND provider_uid = ?")
    .get(p.provider, p.providerUid);
  if (found) {
    db.prepare(`UPDATE user SET email = COALESCE(?, email), name = COALESCE(?, name),
        avatar = COALESCE(?, avatar), last_login_at = ? WHERE id = ?`)
      .run(p.email ?? null, p.name ?? null, p.avatar ?? null, now, (found as any).id);
    return toUser(db.prepare("SELECT * FROM user WHERE id = ?").get((found as any).id));
  }
  const id = newId("u");
  db.prepare(`INSERT INTO user
      (id, provider, provider_uid, email, name, avatar, created_at, last_login_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, p.provider, p.providerUid, p.email ?? null, p.name ?? null, p.avatar ?? null, now, now);
  return toUser(db.prepare("SELECT * FROM user WHERE id = ?").get(id));
}

/* 게스트 — 로그인 없이 바로 쓰는 계정.

   기기에 남는 쿠키가 유일한 열쇠라, 쿠키가 사라지면 그 자료에 다시 닿을 길이 없다.
   그래서 친구 기능은 열지 않는다 — 남과 이어지려면 되찾을 수 있는 계정이어야 한다. */
export const isGuest = (u: User): boolean => u.provider === "guest";

export function createGuest(): User {
  const now = Date.now();
  const id = newId("u");
  db.prepare(`INSERT INTO user
      (id, provider, provider_uid, email, name, avatar, created_at, last_login_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, "guest", id, null, null, null, now, now);
  return toUser(db.prepare("SELECT * FROM user WHERE id = ?").get(id));
}

/** 게스트가 나중에 제대로 로그인할 때, **같은 계정에 그대로** 이어 붙인다.
    새 계정을 만들어 버리면 담아 둔 것이 통째로 갇힌다.
    이미 그 제공자로 만든 계정이 따로 있으면 이을 수 없다 — null 을 돌려주고
    부르는 쪽이 원래대로 그 계정으로 들어가게 한다. */
export function linkGuest(guestId: string, p: {
  provider: string; providerUid: string;
  email?: string | null; name?: string | null; avatar?: string | null;
}): User | null {
  const g = getUser(guestId);
  if (!g || g.provider !== "guest") return null;
  const taken = db.prepare("SELECT 1 FROM user WHERE provider = ? AND provider_uid = ?")
    .get(p.provider, p.providerUid);
  if (taken) return null;
  db.prepare(`UPDATE user SET provider = ?, provider_uid = ?, email = ?, name = ?, avatar = ?,
      last_login_at = ? WHERE id = ?`)
    .run(p.provider, p.providerUid, p.email ?? null, p.name ?? null, p.avatar ?? null,
      Date.now(), guestId);
  return getUser(guestId);
}

/* ── 아이디·비밀번호 계정 ──────────────────────────────────
   되찾을 길(메일 인증 같은 것)을 두지 않았으므로, 비밀번호를 잊으면 그 계정에는
   다시 못 들어간다. 화면에서 그렇게 알린다 — 있는 척하는 것보다 낫다. */
export const PW_PROVIDER = "password";

/** 그 아이디가 이미 쓰이고 있으면 null */
export function createPasswordUser(loginId: string, hash: string): User | null {
  const taken = db.prepare("SELECT 1 FROM user WHERE provider = ? AND provider_uid = ?")
    .get(PW_PROVIDER, loginId);
  if (taken) return null;
  const now = Date.now();
  const id = newId("u");
  db.prepare(`INSERT INTO user
      (id, provider, provider_uid, email, name, avatar, created_at, last_login_at, password_hash)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, PW_PROVIDER, loginId, null, null, null, now, now, hash);
  return toUser(db.prepare("SELECT * FROM user WHERE id = ?").get(id));
}

/** 아이디로 찾는다. 비밀번호 확인은 부르는 쪽이 한다. */
export function passwordUser(loginId: string): { user: User; hash: string } | null {
  const r = db.prepare("SELECT * FROM user WHERE provider = ? AND provider_uid = ?")
    .get(PW_PROVIDER, loginId) as any;
  if (!r?.password_hash) return null;
  return { user: toUser(r), hash: r.password_hash };
}

/** 게스트를 아이디·비밀번호 계정으로 잇는다 — 담아 둔 것을 그대로 데려간다 */
export function linkGuestPassword(guestId: string, loginId: string, hash: string): User | null {
  const g = getUser(guestId);
  if (!g || g.provider !== "guest") return null;
  const taken = db.prepare("SELECT 1 FROM user WHERE provider = ? AND provider_uid = ?")
    .get(PW_PROVIDER, loginId);
  if (taken) return null;
  db.prepare(`UPDATE user SET provider = ?, provider_uid = ?, password_hash = ?, last_login_at = ?
    WHERE id = ?`).run(PW_PROVIDER, loginId, hash, Date.now(), guestId);
  return getUser(guestId);
}

export const markLogin = (id: string): void => {
  db.prepare("UPDATE user SET last_login_at = ? WHERE id = ?").run(Date.now(), id);
};

export const getUser = (id: string): User | null => {
  const r = db.prepare("SELECT * FROM user WHERE id = ?").get(id);
  return r ? toUser(r) : null;
};

export const deleteUser = (id: string): void => {
  db.prepare("DELETE FROM user WHERE id = ?").run(id);   // 나머지는 CASCADE
};

/* ── kv (사용자별 설정·플랫폼 표시) ───────────────────────── */
export function kvGet<T>(userId: string, key: string, fallback: T): T {
  const row = db.prepare("SELECT v FROM kv WHERE user_id = ? AND k = ?").get(userId, key) as
    { v: string } | undefined;
  if (!row) return fallback;
  try { return JSON.parse(row.v) as T; } catch { return fallback; }
}

export function kvSet(userId: string, key: string, value: unknown): void {
  db.prepare(`INSERT INTO kv(user_id, k, v) VALUES(?,?,?)
    ON CONFLICT(user_id, k) DO UPDATE SET v = excluded.v`)
    .run(userId, key, JSON.stringify(value));
}

/* ── 작품 ────────────────────────────────────────────────── */
export type Work = {
  id: string; platformId: string; seriesId: string; title: string; mediaType: string;
  listUrl: string; appUrl: string | null; coverUrl: string | null; coverAspect: number | null;
  episode: string | null;
  state: "active" | "watched" | "dropped"; filed: boolean; visits: number;
  rating: number | null; stateAt: number | null; color: string | null;
  lastAt: number; addedAt: number; folders: string[];
  schedule: { mode: string; days: number[]; next: number | null; source: string; from: number };
};

function toWork(r: any, folders: string[]): Work {
  return {
    id: r.id, platformId: r.platform_id, seriesId: r.series_id, title: r.title,
    mediaType: r.media_type, listUrl: r.list_url, appUrl: r.app_url,
    coverUrl: r.cover_url, coverAspect: r.cover_aspect, episode: r.episode,
    state: r.state, filed: !!r.filed, visits: r.visits, rating: r.rating ?? null,
    stateAt: r.state_at ?? null, color: r.color ?? null,
    lastAt: r.last_at, addedAt: r.added_at, folders,
    schedule: {
      mode: r.sched_mode, days: JSON.parse(r.sched_days) as number[],
      next: r.sched_next, source: r.sched_source,
      from: r.sched_from ?? r.added_at,
    },
  };
}

export function listWorks(userId: string): Work[] {
  const rows = db.prepare("SELECT * FROM work WHERE user_id = ? ORDER BY last_at DESC")
    .all(userId) as any[];
  const links = db.prepare(`SELECT wf.work_id, wf.folder_id FROM work_folder wf
      JOIN work w ON w.id = wf.work_id WHERE w.user_id = ?`).all(userId) as
    { work_id: string; folder_id: string }[];
  const byWork = new Map<string, string[]>();
  for (const l of links) {
    if (!byWork.has(l.work_id)) byWork.set(l.work_id, []);
    byWork.get(l.work_id)!.push(l.folder_id);
  }
  return rows.map(r => toWork(r, byWork.get(r.id) ?? []));
}

/** userId를 함께 받는다 — 남의 작품을 id만으로 집어오지 못하게 한다. */
export function getWork(userId: string, id: string): Work | null {
  const r = db.prepare("SELECT * FROM work WHERE id = ? AND user_id = ?").get(id, userId);
  if (!r) return null;
  const fs = db.prepare("SELECT folder_id FROM work_folder WHERE work_id = ?").all(id) as
    { folder_id: string }[];
  return toWork(r, fs.map(f => f.folder_id));
}

export function setWorkFolders(userId: string, workId: string, folderIds: string[]): void {
  db.prepare("DELETE FROM work_folder WHERE work_id = ?").run(workId);
  const own = db.prepare("SELECT id FROM folder WHERE id = ? AND user_id = ?");
  const ins = db.prepare("INSERT OR IGNORE INTO work_folder(work_id, folder_id) VALUES(?,?)");
  for (const f of folderIds) if (own.get(f, userId)) ins.run(workId, f);
}

export type ShareMode = "none" | "all" | "some";
/** 공개한 폴더를 친구가 가져갈 수 있는 방식 */
export type TakeMode = "none" | "copy" | "mirror" | "both";
export const canCopy = (t: TakeMode): boolean => t === "copy" || t === "both";
export const canMirror = (t: TakeMode): boolean => t === "mirror" || t === "both";

export type Folder = {
  id: string; name: string; emoji: string; ord: number;
  share: { mode: ShareMode; with: string[] };
  take: TakeMode;
  /** 남의 폴더를 비추는 중이면 원본을 가리킨다. 내 폴더면 null. */
  mirror: { owner: string; folder: string } | null;
};

/* 폴더를 읽는 길은 하나다. 목록이든 한 줄이든 조건만 다르다 —
   한 줄 보려고 목록을 통째로 훑고 버리는 일이 없게. */
function folderRows(where: string, ...args: unknown[]): Folder[] {
  const rows = db.prepare(`SELECT id, name, emoji, ord, share_mode, take_mode,
      mirror_owner, mirror_folder FROM folder WHERE ${where} ORDER BY ord, rowid`)
    .all(...args) as any[];
  if (!rows.length) return [];
  const marks = rows.map(() => "?").join(",");
  const pairs = db.prepare(
    `SELECT folder_id, viewer_id FROM folder_share WHERE folder_id IN (${marks})`)
    .all(...rows.map(r => r.id)) as { folder_id: string; viewer_id: string }[];
  const by = new Map<string, string[]>();
  for (const x of pairs) (by.get(x.folder_id) ?? by.set(x.folder_id, []).get(x.folder_id)!).push(x.viewer_id);
  return rows.map(r => ({
    id: r.id, name: r.name, emoji: r.emoji, ord: r.ord,
    share: { mode: (r.share_mode ?? "none") as ShareMode, with: by.get(r.id) ?? [] },
    take: (r.take_mode ?? "copy") as TakeMode,
    mirror: r.mirror_owner && r.mirror_folder
      ? { owner: r.mirror_owner, folder: r.mirror_folder } : null,
  }));
}

export const listFolders = (userId: string): Folder[] => folderRows("user_id = ?", userId);
export const getFolder = (userId: string, id: string): Folder | null =>
  folderRows("user_id = ? AND id = ?", userId, id)[0] ?? null;

/** 폴더 한 줄 만들기 — 새 폴더 · 담아가기 · 미러링이 모두 이 길로 온다 */
export function createFolder(userId: string, p: {
  name: string; emoji?: string; mirror?: { owner: string; folder: string };
}): Folder {
  const id = newId("f");
  const ord = (db.prepare("SELECT COALESCE(MAX(ord), 0) + 1 n FROM folder WHERE user_id = ?")
    .get(userId) as { n: number }).n;
  db.prepare(`INSERT INTO folder(id, user_id, name, emoji, ord, take_mode,
      mirror_owner, mirror_folder) VALUES(?,?,?,?,?,?,?,?)`)
    .run(id, userId, p.name, p.emoji || "📁", ord,
      // 비추는 폴더는 내 것이 아니라 남에게 넘길 수 없다 (sharedView 도 걸러 낸다)
      p.mirror ? "none" : "copy",
      p.mirror?.owner ?? null, p.mirror?.folder ?? null);
  return getFolder(userId, id)!;
}

/** 퍼가기 권한을 정한다 — 비추고 있는 폴더에는 뜻이 없다 (내 것이 아니므로) */
export const setFolderTake = (folderId: string, take: TakeMode): void => {
  db.prepare("UPDATE folder SET take_mode = ? WHERE id = ?").run(take, folderId);
};

/** 그 폴더를 누구에게 보여 줄지 정한다. mode 가 "some" 이 아니면 짝은 지운다. */
export function setFolderShare(folderId: string, mode: ShareMode, viewers: string[]): void {
  db.prepare("UPDATE folder SET share_mode = ? WHERE id = ?").run(mode, folderId);
  db.prepare("DELETE FROM folder_share WHERE folder_id = ?").run(folderId);
  if (mode !== "some") return;
  const ins = db.prepare("INSERT OR IGNORE INTO folder_share(folder_id, viewer_id) VALUES(?,?)");
  for (const v of new Set(viewers)) ins.run(folderId, v);
}

export const newId = (prefix: string): string =>
  prefix + Date.now().toString(36) + Math.trunc(Math.random() * 1e6).toString(36);

/* ── 친구 ────────────────────────────────────────────────── */
export type Friend = { id: string; displayName: string; since: number;
                       sharedFolders: number; starred: boolean };

export function listFriends(userId: string): Friend[] {
  // 세는 것은 "그 친구가 공개한 폴더" 가 아니라 **내게 보이는 폴더** 다 —
  // 고른 친구에게만 연 폴더는 나에게 안 보일 수 있다.
  return (db.prepare(`
    SELECT u.id, u.display_name, f.created_at, f.starred,
           (SELECT COUNT(*) FROM folder fo WHERE fo.user_id = u.id AND (
              fo.share_mode = 'all'
              OR (fo.share_mode = 'some'
                  AND EXISTS (SELECT 1 FROM folder_share fs
                              WHERE fs.folder_id = fo.id AND fs.viewer_id = ?))
           )) AS shared_folders
    FROM friend f JOIN user u ON u.id = f.friend_id
    WHERE f.user_id = ?
    ORDER BY f.starred DESC, f.created_at DESC`).all(userId, userId) as any[])
    .map(r => ({
      id: r.id, displayName: r.display_name ?? "이름 없음",
      since: r.created_at, sharedFolders: r.shared_folders, starred: !!r.starred,
    }));
}

/** 사이드 메뉴에 적을 숫자. 목록은 필요할 때 따로 부른다. */
export const countFriends = (userId: string): number =>
  (db.prepare("SELECT COUNT(*) c FROM friend WHERE user_id = ?").get(userId) as any).c;

/** 별을 켜고 끈다 — 내 줄에만 남으므로 상대는 알지 못한다 */
export function starFriend(userId: string, friendId: string, on: boolean): void {
  db.prepare("UPDATE friend SET starred = ? WHERE user_id = ? AND friend_id = ?")
    .run(on ? 1 : 0, userId, friendId);
}

export const areFriends = (a: string, b: string): boolean =>
  !!db.prepare("SELECT 1 FROM friend WHERE user_id = ? AND friend_id = ?").get(a, b);

export function addFriend(a: string, b: string): void {
  if (a === b) return;
  const now = Date.now();
  const ins = db.prepare("INSERT OR IGNORE INTO friend(user_id, friend_id, created_at) VALUES(?,?,?)");
  ins.run(a, b, now);
  ins.run(b, a, now);   // 양방향 — 한쪽만 보이는 상태가 생기지 않게
}

export function removeFriend(a: string, b: string): void {
  const del = db.prepare("DELETE FROM friend WHERE user_id = ? AND friend_id = ?");
  del.run(a, b);
  del.run(b, a);
}

/** 친구에게 보이는 것 — 그 친구에게 연 폴더와 그 안의 활성 작품뿐이다.
    "모든 친구" 로 연 폴더는 누구에게나, "고른 친구" 는 짝이 있는 사람에게만 보인다. */
export function sharedView(ownerId: string, viewerId: string): { folders: Folder[]; works: Work[] } {
  /* 비추고 있는 폴더는 다시 공개하지 않는다 — 남에게서 받은 것을 또 남에게 넘기는 일이라,
     원래 주인이 한 사람에게만 연 것이 줄줄이 퍼질 수 있다. */
  const folders = listFolders(ownerId).filter(f => !f.mirror).filter(f =>
    f.share.mode === "all" || (f.share.mode === "some" && f.share.with.includes(viewerId)));
  if (!folders.length) return { folders: [], works: [] };
  const ids = folders.map(f => f.id);
  const marks = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT DISTINCT w.* FROM work w
    JOIN work_folder wf ON wf.work_id = w.id
    WHERE w.user_id = ? AND w.state = 'active' AND wf.folder_id IN (${marks})
    ORDER BY w.last_at DESC`).all(ownerId, ...ids) as any[];
  const links = db.prepare(`SELECT work_id, folder_id FROM work_folder
    WHERE folder_id IN (${marks})`).all(...ids) as { work_id: string; folder_id: string }[];
  const byWork = new Map<string, string[]>();
  for (const l of links) {
    if (!byWork.has(l.work_id)) byWork.set(l.work_id, []);
    byWork.get(l.work_id)!.push(l.folder_id);
  }
  return { folders, works: rows.map(r => toWork(r, byWork.get(r.id) ?? [])) };
}

/* ── 초대 ────────────────────────────────────────────────── */
const INVITE_DAYS = 14;

export function createInvite(userId: string): { code: string; expiresAt: number } {
  db.prepare("DELETE FROM invite WHERE user_id = ? OR expires_at < ?").run(userId, Date.now());
  const code = newId("i").slice(1, 11);
  const expiresAt = Date.now() + INVITE_DAYS * 864e5;
  db.prepare("INSERT INTO invite(code, user_id, created_at, expires_at) VALUES(?,?,?,?)")
    .run(code, userId, Date.now(), expiresAt);
  return { code, expiresAt };
}

export function inviteOwner(code: string): User | null {
  const r = db.prepare("SELECT user_id, expires_at FROM invite WHERE code = ?").get(code) as
    { user_id: string; expires_at: number } | undefined;
  if (!r || r.expires_at < Date.now()) return null;
  return getUser(r.user_id);
}
