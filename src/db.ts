/* SQLite 스키마와 접근 계층. 의존성 없이 Node 내장 node:sqlite를 쓴다.

   모든 사용자 데이터는 user_id로 격리된다. 조회 함수가 전부 userId를 받도록 만들어,
   깜빡하고 남의 데이터를 섞어 내보내는 일이 타입 단계에서 걸리게 했다. */
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { DOMAIN_PREFIX } from "./platforms.ts";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/* 곁에서 시험 삼아 띄운 서버가 **돌아가는 서비스의 데이터베이스**를 열어 버리는 일이
   있었다. WAL 잠금은 한 프로세스만 쥘 수 있어서, 그러면 진짜 서버가 못 열고 죽는다
   (`disk I/O error`). DATA_DIR 을 두어 시험판이 제 자리를 쓸 수 있게 한다. */
const DATA_DIR = resolve(process.cwd(), process.env.DATA_DIR ?? "data");
const DB_PATH = resolve(DATA_DIR, "habhobby.db");
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


/* work 표의 정의를 **한 곳에만** 둔다. 켤 때 만드는 자리와 이관에서 다시 세우는
   자리가 둘 다 이것을 쓴다 — 두 벌로 두면 한쪽만 고쳤을 때 조용히 어긋난다. */
const SCHEMA_WORK = `
CREATE TABLE IF NOT EXISTS work (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  url_id       TEXT NOT NULL REFERENCES url(id),
  /* **내 분류.** 담을 때 url 것을 그대로 물려받지만, 「이 도메인은 따로 떼어내기」로
     사람마다 옮길 수 있다. 공용에만 두면 한 사람이 떼어낼 때 모두의 분류가 바뀐다. */
  platform_id  TEXT NOT NULL,
  /* 아래 셋은 **덮어쓰기**다. NULL 이면 url 것을 쓴다 — 「기본값으로 되돌리기」는
     이 칸을 비우는 일이라 원래 값이 저절로 돌아온다. */
  title        TEXT,
  description  TEXT,
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
  color        TEXT                                -- 캘린더 점 색. 없으면 플랫폼 색
);
`;

/* 겹치는 것을 막는 UNIQUE 는 여기 두지 않는다 — 옛 파일에 겹친 줄이 남아 있으면
   표를 세우다 죽는다. 이관이 먼저 합치고, 그다음 keepOneRow() 가 세운다. */
const SCHEMA_WORK_INDEX = `
CREATE INDEX IF NOT EXISTS idx_work_url ON work(url_id);
`;

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

/* 작품 하나가 두 표에 나뉘어 있다.

   가르는 잣대는 하나다 — **남의 서버에서 받아온 것**이냐, **내가 정하고 고치는 것**이냐.
   url 은 모두가 함께 쓰고 아무도 고치지 않는다(읽기 전용 캐시). work 는 사람마다 따로다.

   그래서 「누가 공용 줄을 고칠 권한을 갖나」 하는 물음이 아예 생기지 않는다. 주소를
   잘못 넣었으면 그 줄을 고치는 게 아니라 **내 줄이 다른 url 을 가리키게** 옮긴다. */
CREATE TABLE IF NOT EXISTS url (
  id           TEXT PRIMARY KEY,
  platform_id  TEXT NOT NULL,                      -- 정체를 이루는 값 (아래 UNIQUE)
  series_id    TEXT NOT NULL,
  list_url     TEXT NOT NULL,
  app_url      TEXT,
  media_type   TEXT NOT NULL DEFAULT 'link',
  title        TEXT NOT NULL,
  /** 사이트가 밝힌 소개글. 없으면 NULL — 빈 문자열과 가르지 않는다. */
  description  TEXT,                      -- OG 가 준 원본
  cover_url    TEXT,
  cover_aspect REAL,
  episode      TEXT,                               -- 사이트가 알려준 최신 회차 (아직 안 쓴다)
  fetched_at   INTEGER NOT NULL,
  /* 주소가 아니라 **어느 사이트의 몇 번 작품인가**가 열쇠다. 같은 작품에 이르는 길은
     여럿이다 — 단축 주소, m. 붙은 모바일 주소, 쿼리가 덧붙은 주소. */
  UNIQUE (platform_id, series_id)
);

${SCHEMA_WORK}

CREATE TABLE IF NOT EXISTS folder (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  emoji   TEXT NOT NULL DEFAULT '📁',
  ord     INTEGER NOT NULL DEFAULT 0
);

/* 남의 작품을 **내가** 언제 봤는지. 비추는 폴더와 함께 고치는 폴더에서 쓴다.

   visits·last_at 은 그 작품 주인의 칸이라 내 기록을 적을 수 없다. 적었다면 친구가 열 때마다
   내 목록이 흔들리고, 내가 열면 친구 목록이 흔들렸을 것이다. 보는 사람 쪽에 따로 담는다.

   seen_at 은 붉은 점을 끄고, opened_at 은 **내 목록에서의 차례**를 정한다. */
CREATE TABLE IF NOT EXISTS work_seen (
  user_id   TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  work_id   TEXT NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  seen_at   INTEGER NOT NULL,
  opened_at INTEGER,
  PRIMARY KEY (user_id, work_id)
);

CREATE TABLE IF NOT EXISTS work_folder (
  work_id   TEXT NOT NULL REFERENCES work(id)   ON DELETE CASCADE,
  folder_id TEXT NOT NULL REFERENCES folder(id) ON DELETE CASCADE,
  PRIMARY KEY (work_id, folder_id)
);

-- 사이트가 스스로 밝힌 것 — 이름과 표(favicon). **사이트의 사실이지 내 사실이 아니다.**
-- 한때 사람마다 kv(siteNames)에 따로 적었는데, 같은 사이트를 담은 사람 수만큼 같은 값이
-- 쌓이고 대문도 그만큼 되물었다. url 표를 공용으로 둔 것과 같은 까닭으로 한 줄로 모은다.
-- name 이 ''이면 「읽었는데 이름이 없다」 — 다시 물어도 소용없다는 표시다.
CREATE TABLE IF NOT EXISTS site (
  host       TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  icon       TEXT,
  fetched_at INTEGER NOT NULL
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

/* 이음줄이 끊겼다는 것을 **끊긴 사람에게** 남긴다.

   미러링과 폴더 공유는 읽을 때마다 주인 것을 가져다 보여 주는 방식이라, 주인이 설정을
   바꾸면 다음에 화면을 그릴 때 그냥 비어 버린다. 폴더 줄에 왜인지가 적히기는 하지만
   **폴더를 열어 봐야** 보이므로, 자주 안 여는 폴더라면 끊긴 줄도 모르고 지낸다.

   실시간으로 밀어 줄 필요는 없다 — 웹소켓은 늘 붙어 있어야 해서 값이 비싸고, 이건
   "언젠가 알면 되는" 소식이다. 새로 고칠 때 함께 실려 오면 충분하다.

   폴더 이름과 주인 이름을 **그때 값으로 박아 둔다**: 폴더가 지워지면 이름을 물어볼 데가
   없고, 이름이 바뀌어도 끊길 당시의 그 이름이라야 사람이 알아본다. 같은 이유로
   folder_id 에 외래키를 걸지 않는다. */
CREATE TABLE IF NOT EXISTS folder_notice (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  folder_id  TEXT,
  name       TEXT NOT NULL,
  emoji      TEXT NOT NULL DEFAULT '📁',
  owner_name TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notice_user ON folder_notice(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_work_user   ON work(user_id, state);
CREATE INDEX IF NOT EXISTS idx_folder_user ON folder(user_id);
CREATE INDEX IF NOT EXISTS idx_session_exp ON session(expires_at);


-- work_folder 의 기본키는 (work_id, folder_id) 라 **작품에서 폴더로** 가는 길만 나 있다.
-- 그런데 자주 묻는 것은 반대쪽이다: "이 폴더에 무엇이 들어 있나". 비추는 폴더, 함께 쓰는
-- 폴더, 담아갈 것 고르기가 모두 그 길로 다니는데 색인이 없어 표를 통째로 훑고 있었다
-- (EXPLAIN QUERY PLAN 이 SCAN work_folder 라 답했다). 되짚는 길을 낸다.
CREATE INDEX IF NOT EXISTS idx_wf_folder    ON work_folder(folder_id);
-- folder_share 도 같다. 기본키는 (folder_id, viewer_id) 인데 "나에게 온 초대" 는
-- viewer_id 로 묻고, 그건 앱을 열 때마다 도는 질의다.
CREATE INDEX IF NOT EXISTS idx_share_viewer ON folder_share(viewer_id);
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
/* 소개글 — 공용 줄과 내 덮어쓰기, 제목·표지와 같은 두 층이다. */
try { db.exec("ALTER TABLE url ADD COLUMN description TEXT"); } catch { /* 이미 있음 */ }
try { db.exec("ALTER TABLE work ADD COLUMN description TEXT"); } catch { /* 이미 있음 */ }
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
/* 자주 여는 폴더에 별을 켠다. 친구의 별과 같은 뜻이다 — 남과 나누는 값이 아니라
   **내 목록의 차례**를 정하는 나만의 표시라, 비추는 폴더에 켜도 주인은 모른다. */
try { db.exec("ALTER TABLE folder ADD COLUMN starred INTEGER NOT NULL DEFAULT 0"); } catch { }
try { db.exec("ALTER TABLE folder ADD COLUMN mirror_owner  TEXT"); } catch { }
try { db.exec("ALTER TABLE folder ADD COLUMN mirror_folder TEXT"); } catch { }
/* 함께 고치는 폴더에 이름이 올랐다고 곧바로 참여자가 되지는 않는다 — **수락해야** 한다.
   pending(초대함) · ok(수락함). 거절하면 줄을 지우므로 따로 값을 두지 않는다.

   기본을 ok 로 둔다: 이 칸이 생기기 전에 공개해 둔 폴더들은 이미 보이고 있었으므로,
   말없이 pending 으로 되돌리면 어제까지 보이던 것이 오늘 사라진다. */
try { db.exec("ALTER TABLE folder_share ADD COLUMN state TEXT NOT NULL DEFAULT 'ok'"); } catch { }
/* 이미 내려둔 작품은 언제 내렸는지 모른다 — 마지막으로 연 때를 대신 쓴다.
   캘린더에 남길 구간의 끝을 정하는 값이라 비워두면 아예 안 보인다. */
db.prepare("UPDATE work SET state_at = last_at WHERE state != 'active' AND state_at IS NULL").run();

/* 아래 손질들은 **한 번 하면 끝나는 일**이다. 그런데 표식이 없는 것들이 있어 켤 때마다
   다시 돌았다 — 작품 표를 통째로 훑고, 주소를 하나씩 뜯어보고, 고칠 것이 없다는 결론을
   매번 새로 냈다. DB 자체의 판 번호를 표식 삼아 지나간 것은 건너뛴다.
   kv 를 쓸 수 없는 이유는 그것이 사용자에 묶여 있어서다 — 표 전체에 대한 표식이 필요하다. */
const schemaV = (): number =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

/* **빈 파일에는 옮길 것이 없다.**

   이관들은 옛 데이터를 손보는 코드라, 사람이 하나도 없는 파일에서는 할 일이 없다.
   그런데 판 번호가 0 이라 전부 돌려고 하고, 그 과정에서 이제는 없는 컬럼을 짚어
   켜지지도 않는다(실제로 app_url 에서 걸렸다).

   그래서 처음 만들어진 파일은 **끝난 것으로 표시하고 시작한다.** 옮길 줄이 없으니
   건너뛰는 것이 곧 옳은 결과다. */
/* **마지막 이관 번호와 맞춰 둔다.** 뒤에 once() 를 더하면 이 숫자도 함께 올린다 —
   안 올려도 빈 표에 돌아 탈은 없지만, 새 파일이 「끝난 것」인데 끝나지 않은 번호를
   달고 있으면 다음 사람이 그 어긋남부터 풀어야 한다. */
const LATEST_V = 12;
if (schemaV() === 0) {
  const empty = !db.prepare("SELECT 1 FROM user LIMIT 1").get();
  if (empty) db.exec("PRAGMA user_version = " + LATEST_V);
}

/** 이 판까지 손질이 끝났으면 건너뛴다. 아니면 돌리고 판 번호를 올린다. */
function once(v: number, fn: () => void): void {
  if (schemaV() >= v) return;
  fn();
  db.exec("PRAGMA user_version = " + v);
}

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
/* 한때 작품 페이지가 밝힌 og:site_name 을 구간 이름으로 삼았는데, 남의 메타 태그를 베껴 둔
   페이지가 있어 엉뚱한 이름이 박혔다(교보문고 전자책 → "IMDb"). 이제 도메인 대문에만
   물어보므로, 그때 저장된 이름은 한 번 비워 다시 받게 한다. 사용자가 직접 지은 이름은
   overrides 에 따로 있으므로 영향이 없다. */
once(1, () => {
  const n = db.prepare("DELETE FROM kv WHERE k = 'siteNames'").run().changes;
  if (n) console.log(`  구간 이름 재조회 예약: ${n}명분`);
});

/* 줄바꿈과 들여쓰기를 og:title 에 그대로 넣어 둔 페이지가 있어, 제목에 공백이 수십 칸씩
   들어간 것들이 저장돼 있다. 이제 받을 때 줄이지만 이미 담긴 것은 여기서 편다. */
once(2, () => {
  const rows = db.prepare("SELECT id, title FROM work").all() as { id: string; title: string }[];
  const upd = db.prepare("UPDATE work SET title = ? WHERE id = ?");
  let n = 0;
  for (const r of rows) {
    const t = r.title.replace(/\s+/g, " ").trim();
    if (t && t !== r.title) { upd.run(t, r.id); n++; }
  }
  if (n) console.log(`  제목의 군더더기 공백 정리: ${n}편`);
});

/* 네이버웹툰 앱 스킴을 짐작으로 적어 두었던 때가 있다(naverwebtoon://). 그 주소로는
   앱이 열리지 않는다 — 이미 담긴 작품들의 주소도 바른 것으로 바꾼다. */
once(3, () => {
  const n = db.prepare(
    `UPDATE work SET app_url = 'webtoonkr://contentList?version=2&league=WEBTOON&titleId='
       || substr(app_url, length('naverwebtoon://contentList?titleId=') + 1)
     WHERE app_url LIKE 'naverwebtoon://contentList?titleId=%'`).run().changes;
  if (n) console.log(`  네이버웹툰 앱 주소 정리: ${n}편`);
});

/* 글(블로그) 매체에 회차를 붙여 저장하던 때가 있다. 그 자리에 담긴 건 회차가 아니라
   글 번호이므로 비운다. 매체를 보고 가르므로 플랫폼이 늘어도 그대로 적용된다. */
once(4, () => {
  const n = db.prepare("UPDATE work SET episode = NULL WHERE media_type = 'text' AND episode IS NOT NULL")
    .run().changes;
  if (n) console.log(`  글 매체의 회차 표기 정리: ${n}편`);
});

/* 도메인 되돌리기도 한 번이면 된다 — 주소를 한 줄씩 뜯어보는 일이라 가장 비쌌다. */
once(5, restoreHostGrouping);

/* 표시 이름은 **친구에게 보이는 유일한 신원**이다. 아이디도 프로필 사진도 보여 주지
   않으므로, 같은 이름이 둘이면 초대 명단에서 어느 「김지훈」인지 가릴 방법이 없다.
   골라 놓고 엉뚱한 사람에게 폴더를 열어 줄 수 있다는 뜻이다 — 겹치지 않게 막는다.

   막는 자리는 둘이다. 하나는 이름을 정하는 길목(setDisplayName), 하나는 여기 색인.
   길목만 막아도 한 프로세스에서는 새지 않지만, 지키는 규칙은 표 자체가 들고 있어야
   나중에 다른 길이 생겨도 무너지지 않는다.

   비교는 **접어서** 한다(foldName) — 대소문자와 군더더기 공백만 다른 이름은 사람 눈에
   같은 이름이고, 눈에 보이지 않는 글자로 다르게 만든 이름은 더 나쁘다. */
once(6, () => {
  /* 이미 겹쳐 있는 것부터 푼다. 늦게 만든 계정에 번호를 붙인다 — 먼저 쓰던 사람의
     이름을 빼앗지 않는다. */
  const rows = db.prepare(`SELECT id, display_name FROM user
    WHERE display_name IS NOT NULL AND TRIM(display_name) <> '' ORDER BY rowid`)
    .all() as { id: string; display_name: string }[];
  const seen = new Set<string>();
  const upd = db.prepare("UPDATE user SET display_name = ? WHERE id = ?");
  let n = 0;
  for (const r of rows) {
    const clean = cleanName(r.display_name);
    let want = clean, k = foldName(clean), i = 1;
    while (!k || seen.has(k)) { want = `${clean} ${++i}`; k = foldName(want); }
    seen.add(k);
    if (want !== r.display_name) { upd.run(want, r.id); n++; }
  }
  if (n) console.log(`  겹치던 표시 이름 정리: ${n}명`);
  /* 이름이 없는 계정은 이 규칙 밖이다 — 아직 정하지 않았을 뿐이라 서로 겹칠 것이 없다.
     부분 색인이 아니면 NULL 이 아닌 빈 문자열끼리 부딪힌다. */
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_name
    ON user(LOWER(TRIM(display_name)))
    WHERE display_name IS NOT NULL AND TRIM(display_name) <> ''`);
});

/* 퍼가기 갈래를 「하나 고르기」에서 「셋을 켜고 끄기」로 옮긴다.

   옛 값은 다섯이었고 새 값은 쉼표로 이은 집합이다. 「둘 다」는 둘을 켜면 되고,
   「보기만」은 셋이 다 꺼진 것과 같아 비공개가 된다 — 보이기만 하고 아무것도 못 하는
   자리는 없앤다(고르는 사람에게 그 차이가 뚜렷하지 않았다).

   「폴더 공유」는 예전에 담아가기·미러링을 저절로 포함했지만 이제는 독립이다.
   함께 쓰는 사람이 담아가기까지 하려면 클로닝을 함께 켜면 된다. */
once(8, () => {
  const map: Record<string, string> = {
    none: "", copy: "copy", mirror: "mirror", both: "copy,mirror", edit: "edit",
  };
  const rows = db.prepare("SELECT id, take_mode FROM folder").all() as
    { id: string; take_mode: string }[];
  const upd = db.prepare("UPDATE folder SET take_mode = ? WHERE id = ?");
  let n = 0;
  for (const r of rows) {
    const want = map[r.take_mode];
    if (want === undefined || want === r.take_mode) continue;
    upd.run(want, r.id);
    n++;
  }
  if (n) console.log(`  퍼가기 갈래를 켜고 끄는 방식으로 옮김: ${n}개`);
});

/* 폴더의 갈래를 둘로 못 박는다 — 일반("" · copy · mirror · copy,mirror)과 공유("edit").

   셋을 자유롭게 조합할 수 있던 때에 만들어진 폴더 중 **edit 와 copy·mirror 를 함께 켠
   것**이 남아 있다. 그런 폴더는 「함께 쓰는 사이인데 아무나 담아갈 수도 있는」 상태라
   범위 하나로 두 가지를 뜻하고 있었다.

   **edit 를 남긴다.** 함께 쓰자고 부른 사람이 이미 있고 그쪽 화면에 그 폴더가 서 있는데
   edit 를 떼면 그 사람들이 통째로 떨어져 나간다. 담아가기를 잃는 쪽이 되돌리기 쉽다 —
   필요하면 일반 폴더를 새로 만들어 열면 된다. */
once(9, () => {
  const rows = db.prepare(
    "SELECT id, take_mode FROM folder WHERE take_mode LIKE '%edit%' AND take_mode <> 'edit'",
  ).all() as { id: string; take_mode: string }[];
  const upd = db.prepare("UPDATE folder SET take_mode = 'edit' WHERE id = ?");
  for (const r of rows) upd.run(r.id);
  if (rows.length) console.log(`  갈래가 섞인 폴더를 공유 폴더로 좁힘: ${rows.length}개`);

  /* 같은 김에 규칙 밖의 낱말 하나를 씻는다. createFolder 가 비추는 폴더에 "none" 을
     적고 있었는데, 그건 갈래가 다섯이던 때의 값이고 지금은 빈 글자가 그 뜻이다.
     canCopy 들이 모두 거짓을 내주어 탈은 안 났지만, 표에 규칙 밖의 값이 남아 있으면
     다음에 이 컬럼을 읽는 사람이 그것부터 풀어야 한다. */
  const n = db.prepare("UPDATE folder SET take_mode = '' WHERE take_mode = 'none'").run().changes;
  if (n) console.log(`  옛 낱말 none 을 빈 글자로: ${n}개`);
});

/* 이용 완료에 같은 작품이 여러 줄 있던 것을 한 줄로 줄인다.

   **가장 나중에 끝낸 것을 남긴다** — 제목·별점·폴더가 지금 것이기 때문이다.
   이 이관이 먼저 돌아야 아래의 idx_work_done(부분 UNIQUE)이 세워진다: 겹친 줄이 남아
   있으면 인덱스 만들기가 실패하고, 그러면 서버가 아예 안 뜬다. */
once(10, () => {
  /* **더 나중의 것이 하나라도 있으면 이 줄은 지운다.** 「남길 것을 고른다」로 쓰면
     동점을 가르는 데가 없어 둘 다 남거나 둘 다 사라진다. 지울 것을 고르는 쪽이
     한 줄만 살아남는 것을 저절로 보장한다 — 나중(state_at), 같으면 rowid 로 가른다. */
  const n = db.prepare(`DELETE FROM work WHERE state = 'watched' AND EXISTS (
      SELECT 1 FROM work o
       WHERE o.user_id = work.user_id AND o.url_id = work.url_id AND o.state = 'watched'
         AND ( COALESCE(o.state_at, 0) > COALESCE(work.state_at, 0)
            OR (COALESCE(o.state_at, 0) = COALESCE(work.state_at, 0) AND o.rowid > work.rowid) ))`)
    .run().changes;
  if (n) console.log(`  겹친 이용 완료를 한 줄로: ${n}줄 거둠`);
});

/* 사람마다 kv 에 적어 두던 사이트 이름(siteNames)을 공용 site 표로 옮긴다.
   먼저 적은 사람의 값이 남는다 — 같은 사이트의 이름이라 누구 것이든 같다. 옮긴 뒤
   kv 줄은 지운다: 남겨 두면 어느 쪽이 진짜인지 다음 사람이 가려야 한다. */
once(11, () => {
  const rows = db.prepare("SELECT user_id, v FROM kv WHERE k = 'siteNames'").all() as { user_id: string; v: string }[];
  const ins = db.prepare("INSERT OR IGNORE INTO site(host, name, icon, fetched_at) VALUES(?,?,NULL,?)");
  let n = 0;
  for (const r of rows) {
    let names: Record<string, string> = {};
    try { names = JSON.parse(r.v); } catch { continue; }
    for (const [pid, name] of Object.entries(names)) {
      if (!pid.startsWith(DOMAIN_PREFIX)) continue;
      if (ins.run(pid.slice(DOMAIN_PREFIX.length), name ?? "", Date.now()).changes) n++;
    }
  }
  db.prepare("DELETE FROM kv WHERE k = 'siteNames'").run();
  if (rows.length) console.log(`  사이트 이름을 공용 표로 옮김: ${n}개 (${rows.length}명분)`);
});

/* **한 사람에게 같은 작품은 한 줄이다** — 휴지통만 빼고.

   한때 살아 있는 것과 이용 완료를 따로 세어 저마다 한 줄씩 허락했다. 그래서 이용 완료한
   작품을 친구 폴더에서 담아 오거나 주소로 다시 담으면 **줄이 하나 더 생겼다.** 목록에
   안 서던 때는 눈에 안 띄었는데, 이용 완료를 페이지·폴더에 세우기 시작하자 같은 작품이
   두 장씩 보였다.

   **가장 나중의 결정이 이긴다.** 정한 때(state_at)가 없으면 담은 때(added_at)로 본다 —
   그래야 「오래전에 다 봤는데 어제 다시 담았다」와 「오래전에 담았는데 어제 다 봤다」가
   서로 다른 답을 낸다. 지는 줄의 폴더·별점·표지·제목은 이긴 줄이 물려받는다:
   합치는 일이지 버리는 일이 아니다. */
once(12, () => {
  const dups = db.prepare(`SELECT user_id, url_id FROM work WHERE state <> 'dropped'
    GROUP BY user_id, url_id HAVING COUNT(*) > 1`).all() as
    { user_id: string; url_id: string }[];
  const rowsOf = db.prepare(`SELECT id, rating, visits, last_at, title, cover_url, cover_aspect
      FROM work WHERE user_id = ? AND url_id = ? AND state <> 'dropped'
      ORDER BY COALESCE(state_at, added_at) DESC, rowid DESC`);
  const moveFolders = db.prepare(`INSERT OR IGNORE INTO work_folder(work_id, folder_id)
      SELECT ?, folder_id FROM work_folder WHERE work_id = ?`);
  const inherit = db.prepare(`UPDATE work SET rating = COALESCE(rating, ?),
      title = COALESCE(title, ?), cover_url = COALESCE(cover_url, ?),
      cover_aspect = COALESCE(cover_aspect, ?),
      visits = MAX(visits, ?), last_at = MAX(last_at, ?) WHERE id = ?`);
  const drop = db.prepare("DELETE FROM work WHERE id = ?");
  let n = 0;
  for (const d of dups) {
    const rows = rowsOf.all(d.user_id, d.url_id) as any[];
    const keep = rows[0];
    for (const r of rows.slice(1)) {
      moveFolders.run(keep.id, r.id);
      inherit.run(r.rating, r.title, r.cover_url, r.cover_aspect, r.visits, r.last_at, keep.id);
      drop.run(r.id);
      n++;
    }
  }
  if (n) console.log(`  살아 있는 줄과 이용 완료 줄을 한 줄로: ${n}줄 거둠`);
});

/* 작품 하나를 url(공용)과 work(내 것)로 가른다.

   **옛 줄은 옮기지 않는다.** 이 이관을 하기 전에 계정을 전부 비웠고(가입 0명), 옮길
   값이 없다. 옛 표를 그대로 두면 위의 CREATE TABLE IF NOT EXISTS 가 아무 일도 안 해서
   옛 모양이 살아남는다 — 그래서 버리고 다시 세운다.

   **줄이 남아 있으면 손대지 않는다.** 혹시 데이터가 든 파일에서 이 코드가 돌면 말없이
   지우는 것보다 멈추는 편이 낫다. */
once(7, () => {
  const has = (t: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (!has("work")) return;
  const cols = (db.prepare("PRAGMA table_info(work)").all() as { name: string }[]).map(c => c.name);
  if (cols.includes("url_id")) return;                    // 이미 새 모양이다

  const n = (db.prepare("SELECT COUNT(*) c FROM work").get() as { c: number }).c;
  if (n > 0) {
    console.log(`  ⚠ work 에 ${n}줄이 남아 있어 url/work 가르기를 건너뜁니다.`);
    console.log("    비운 뒤 다시 켜거나, 옮기는 코드를 손으로 써 주세요.");
    return;
  }
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("DROP TABLE work");
  db.exec(SCHEMA_WORK);
  db.exec("PRAGMA foreign_keys = ON");
  console.log("  url / work 로 갈랐습니다");
});

/* work 의 색인은 **이관이 끝난 뒤에** 만든다. 켤 때 도는 스키마 블록에서 만들면
   옛 파일에서는 아직 url_id 칸이 없어 걸린다(once(7) 이 표를 다시 세우기 전이다). */
db.exec(SCHEMA_WORK_INDEX);

/* ── 질의문을 다시 쓴다 ────────────────────────────────────
   db.prepare 는 부를 때마다 SQL 을 새로 컴파일한다 — 한 번에 0.1ms 남짓인데, 우리는 같은
   문장을 요청마다 되풀이해 부르므로 그것만으로 질의 값의 3분의 1을 썼다. 한 번 만든 것을
   글자 그대로 기억해 두었다가 다시 쓴다.

   **놓는 자리가 여기여야 한다.** 위의 ALTER TABLE 들이 다 끝난 뒤다 — 기억해 둔
   SELECT * 는 준비하던 때의 칸만 알기 때문에, 칸이 늘기 전에 만든 문장을 그대로 쓰면
   새 칸이 빠진다. 켤 때 스키마가 자리를 잡고 나면 그 뒤로는 바뀌지 않는다. */
{
  const compile = db.prepare.bind(db);
  const kept = new Map<string, ReturnType<typeof compile>>();
  db.prepare = (sql: string) => {
    let st = kept.get(sql);
    // 폴더 수만큼 ? 를 붙여 만드는 문장이 있어 종류가 끝없이 늘 수 있다 — 빗장을 둔다
    if (!st) { st = compile(sql); if (kept.size < 500) kept.set(sql, st); }
    return st;
  };
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
const PW_PROVIDER = "password";

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

/* ── 표시 이름 ────────────────────────────────────────────
   친구에게 보이는 유일한 신원이다. 그래서 **겹치면 안 된다** — 초대 명단에 「김지훈」이
   둘 있으면 어느 쪽인지 가릴 것이 없고, 골라 놓고 엉뚱한 사람에게 폴더를 열어 준다. */

/** 담기 전에 다듬는다 — 눈에 보이지 않는 글자를 걷고 공백을 한 칸으로 모은다. */
export function cleanName(s: string): string {
  return String(s ?? "")
    /* 폭 없는 글자(zero-width)와 제어 문자를 걷는다. 이것을 두면 「김지훈」과
       「김<zwsp>지훈」이 화면에서는 똑같은데 표에서는 다른 이름이 되어, 겹치지 말라는
       규칙을 눈속임으로 넘을 수 있다. */
    .replace(/[\u0000-\u001f\u007f\u00ad\u200b-\u200f\u2028\u2029\u2060\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);
}

/** 견줄 때 쓰는 모양 — 대소문자만 다른 이름은 사람 눈에 같은 이름이다.

    **함수 선언으로 둔다.** 켤 때 도는 이관(once(6))이 이 줄보다 위에서 부르는데,
    화살표 함수를 담은 const 는 그 자리에서 아직 만들어지지 않아 켜자마자 죽는다. */
function foldName(s: string): string { return cleanName(s).toLowerCase(); }

/** 그 이름을 이미 쓰는 사람이 있는가. `except` 는 자기 자신(이름을 그대로 두는 경우). */
function nameTaken(name: string, except?: string): boolean {
  const k = foldName(name);
  if (!k) return false;
  const r = db.prepare(`SELECT id FROM user
    WHERE LOWER(TRIM(display_name)) = ? AND id <> ?`).get(k, except ?? "") as any;
  return !!r;
}

/** 이름을 정한다. 겹치면 담지 않고 `null` 을 돌려준다 — 부르는 쪽이 사람에게 알린다. */
export function setDisplayName(userId: string, name: string): string | null {
  const want = cleanName(name);
  if (!want) return null;
  if (nameTaken(want, userId)) return null;
  try {
    db.prepare("UPDATE user SET display_name = ? WHERE id = ?").run(want, userId);
  } catch {
    /* 위에서 봤는데도 여기서 걸렸다면 색인이 잡은 것이다 — 같은 이름을 동시에 정하려는
       두 요청이 있었다는 뜻. 사람에게는 "이미 쓰는 이름" 으로 똑같이 보인다. */
    return null;
  }
  return want;
}

/* ── kv (사용자별 설정·플랫폼 표시) ───────────────────────── */
/* ── 사이트 표 ── */
export type Site = { host: string; name: string; icon: string | null; fetchedAt: number };
export const getSite = (host: string): Site | null => {
  const r = db.prepare("SELECT host, name, icon, fetched_at FROM site WHERE host = ?").get(host) as any;
  return r ? { host: r.host, name: r.name, icon: r.icon, fetchedAt: r.fetched_at } : null;
};
/** 여러 호스트를 한 번에 — 구간을 그릴 때 사람당 한 번이면 된다 */
export function sitesFor(hosts: string[]): Map<string, Site> {
  if (!hosts.length) return new Map();
  const rows = db.prepare(`SELECT host, name, icon, fetched_at FROM site
    WHERE host IN (${hosts.map(() => "?").join(",")})`).all(...hosts) as any[];
  return new Map(rows.map(r => [r.host, { host: r.host, name: r.name, icon: r.icon, fetchedAt: r.fetched_at }]));
}
export const setSite = (host: string, name: string | null, icon: string | null): void => {
  db.prepare(`INSERT INTO site(host, name, icon, fetched_at) VALUES(?,?,?,?)
    ON CONFLICT(host) DO UPDATE SET name = excluded.name, icon = excluded.icon, fetched_at = excluded.fetched_at`)
    .run(host, name ?? "", icon, Date.now());
};
export const forgetSite = (host: string): void => { db.prepare("DELETE FROM site WHERE host = ?").run(host); };

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
  id: string;
  /** 이 작품이 가리키는 **공용 url 줄**. 「내 목록에 같은 작품이 있는가」를 묻는 열쇠다 —
      제목은 저마다 고쳐 쓸 수 있고 platformId 는 내 분류라, 같음을 가리는 것은 이것뿐이다. */
  urlId: string;
  platformId: string; seriesId: string; title: string; mediaType: string;
  /** 사이트가 밝힌 소개글 위에 내가 고쳐 쓴 것 — 읽을 때는 이미 합쳐져 온다. */
  description: string | null;
  listUrl: string; appUrl: string | null; coverUrl: string | null; coverAspect: number | null;
  episode: string | null;
  state: "active" | "watched" | "dropped"; filed: boolean; visits: number;
  rating: number | null; stateAt: number | null; color: string | null;
  lastAt: number; addedAt: number; folders: string[];
  schedule: { mode: string; days: number[]; next: number | null; source: string; from: number };
};

/* 작품 한 줄을 읽는 SQL 은 **여기 하나뿐**이다.

   work(내 것)와 url(공용)을 이어 붙이고, 덮어쓸 수 있는 셋은 내 값이 있으면 그것을,
   없으면 공용 것을 고른다. 이렇게 합쳐 두면 밖에서 보는 모양(Work)이 쪼개기 전과
   똑같아서, 판단 로직과 화면 코드는 이 공사를 모른다.

   platform_id 는 COALESCE 하지 않는다 — 그건 덮어쓰기가 아니라 **내 분류**라서
   담을 때 이미 제 값이 들어 있다. */
const WORK_COLS = `
  w.id, w.user_id, w.url_id, w.platform_id, w.state, w.filed, w.visits,
  w.last_at, w.added_at, w.sched_mode, w.sched_days, w.sched_next,
  w.sched_source, w.sched_from, w.rating, w.state_at, w.color,
  COALESCE(w.title, u.title)               AS title,
  COALESCE(w.description, u.description)   AS description,
  COALESCE(w.cover_url, u.cover_url)       AS cover_url,
  COALESCE(w.cover_aspect, u.cover_aspect) AS cover_aspect,
  COALESCE(w.episode, u.episode)           AS episode,
  u.series_id, u.list_url, u.app_url, u.media_type`;

const WORK_FROM = "FROM work w JOIN url u ON u.id = w.url_id";

function toWork(r: any, folders: string[]): Work {
  return {
    id: r.id, urlId: r.url_id, platformId: r.platform_id, seriesId: r.series_id, title: r.title,
    description: r.description ?? null,
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
  const rows = db.prepare(
    `SELECT ${WORK_COLS} ${WORK_FROM} WHERE w.user_id = ? ORDER BY w.last_at DESC`)
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
  const r = db.prepare(`SELECT ${WORK_COLS} ${WORK_FROM} WHERE w.id = ? AND w.user_id = ?`)
    .get(id, userId);
  if (!r) return null;
  const fs = db.prepare("SELECT folder_id FROM work_folder WHERE work_id = ?").all(id) as
    { folder_id: string }[];
  return toWork(r, fs.map(f => f.folder_id));
}

/** **이미 내가 들고 있는 같은 작품** — 살아 있든 이용 완료든. 없으면 null.

    upsertWork 가 「이미 담았나」를 가리는 것과 **같은 길**로 찾는다: url 을
    구간+시리즈로 집고, 그 줄을 내가 갖고 있는지 본다. 등록 화면이 이것을 미리 물어
    지금 값을 띄우므로, 짐작이 서로 어긋나면 화면과 저장이 갈린다 — 그래서 한 길이어야 한다.

    **휴지통만 「없는」 것으로 본다.** 이용 완료는 들고 있는 것이다 — 거기 있는 주소를
    다시 담아 줄을 하나 더 만들면 같은 작품이 화면에 두 장 선다. 담기는 그 줄의 정보를
    새로 적고, 목록으로 되돌리는 일은 「복구」가 맡는다. */
export function findKeptWork(userId: string, platformId: string, seriesId: string): Work | null {
  const r = db.prepare(`SELECT w.id FROM work w JOIN url u ON u.id = w.url_id
    WHERE w.user_id = ? AND u.platform_id = ? AND u.series_id = ? AND w.state <> 'dropped'`)
    .get(userId, platformId, seriesId) as { id: string } | undefined;
  return r ? getWork(userId, r.id) : null;
}

/** 표지 주소가 **시한부**인가 — 서명과 만료가 박혀 있는 것들.

    인스타그램(`_nc_*`·`oe`·`oh`), CloudFront(`Expires`·`Signature`·`Key-Pair-Id`),
    S3(`X-Amz-*`) 가 이런 주소를 준다. 차단당해서가 아니라 **원래 그렇게 설계되어**
    며칠이면 깨진다. 네이버 웹툰이나 넷플릭스 주소는 여기 안 걸린다 — 몇 년째 그대로다. */
const EXPIRING = /[?&](_nc_[a-z]+|oe|oh|st|Expires|X-Amz-[A-Za-z]+|Signature|Key-Pair-Id|token|sig)=/i;

/** 다시 받아 와야 할 표지들 — 시한부인데 받아 둔 지 오래된 것부터.

    **전부 도는 것이 아니다.** 멀쩡한 주소까지 주기적으로 확인하면 남의 서버를 쉼 없이
    두드리게 되고, 그건 우리가 피하려던 바로 그 일이다. 깨질 것이 확실한 것만 챙긴다. */
export function staleCovers(olderThanMs: number, limit: number) {
  const rows = db.prepare(`SELECT id, list_url, cover_url, fetched_at
    FROM url WHERE cover_url IS NOT NULL AND fetched_at < ?
    ORDER BY fetched_at ASC LIMIT ?`)
    .all(Date.now() - olderThanMs, limit * 8) as any[];
  return rows.filter(r => EXPIRING.test(r.cover_url))
    .slice(0, limit)
    .map(r => ({ id: r.id as string, listUrl: r.list_url as string }));
}

/** 새로 받아온 표지로 고친다. **표지만** 손댄다 — 제목까지 고치면 직접 안 고친 사람
    전부의 목록에서 이름이 하룻밤에 바뀐다. 받아온 것이 없으면 그대로 둔다:
    못 읽었다고 멀쩡한 표지를 지우면 있던 것마저 사라진다. */
export function refreshCover(urlId: string, coverUrl: string, coverAspect: number | null): void {
  db.prepare("UPDATE url SET cover_url = ?, cover_aspect = ?, fetched_at = ? WHERE id = ?")
    .run(coverUrl, coverAspect, Date.now(), urlId);
}

/** 다시 읽어는 봤으나 새 표지를 못 얻은 경우 — 표지는 그대로 두고 **본 때만** 적는다.
    그래야 다음 차례에 같은 것만 붙들고 있지 않는다. */
export const markChecked = (urlId: string): void => {
  db.prepare("UPDATE url SET fetched_at = ? WHERE id = ?").run(Date.now(), urlId);
};

/** 이미 담아 둔 작품인가 — **긁기 전에** 물어본다.

    주소에서 「어느 사이트의 몇 번 작품인가」를 뽑는 데는 네트워크가 들지 않으므로,
    그것만으로 여기를 찾아볼 수 있다. 있으면 남의 페이지를 다시 읽을 이유가 없다. */
export function knownUrl(platformId: string, seriesId: string) {
  const r = db.prepare(`SELECT list_url, app_url, media_type, title, description,
      cover_url, cover_aspect, episode
    FROM url WHERE platform_id = ? AND series_id = ?`).get(platformId, seriesId) as any;
  if (!r) return null;
  return {
    listUrl: r.list_url as string, appUrl: r.app_url as string | null,
    mediaType: r.media_type as string, title: r.title as string,
    description: (r.description ?? null) as string | null,
    coverUrl: r.cover_url as string | null, coverAspect: r.cover_aspect as number | null,
    episode: r.episode as string | null,
  };
}

/** 주소로 공용 줄을 찾거나 새로 만든다. **여기가 url 에 쓰는 유일한 길이다.**

    이미 있으면 그대로 쓴다 — 남이 담아 둔 줄을 내가 담는다고 고쳐 쓰면, 그 사람 화면의
    제목과 표지가 말없이 바뀐다. 사이트가 준 값이 달라졌더라도 그건 공용 줄의 문제이지
    지금 담는 사람이 정할 일이 아니다. */
/** 이 소개글이 **이 작품의 것인가.**

    넷플릭스는 어느 작품 주소를 넣어도 같은 말을 내놓는다 — 「스마트 TV, 태블릿…
    마음껏 즐기세요」. 값은 오는데 쓸 수 없는 값이다. 제목에서 pageIsGeneric 이 하는
    일을 소개글에서도 해야 하는데, 한 페이지만 보아서는 그것이 대문 문구인지 알 수 없다.

    **같은 구간의 다른 작품과 글자 하나 안 다르면** 그건 작품의 것이 아니다. 목록을
    하드코딩하지 않고도 가려낼 수 있는 유일한 신호다 — 두 번째 작품을 담는 순간 드러난다.

    드러나면 **먼저 담긴 쪽도 지운다.** 그 값도 애초에 그 작품의 것이 아니었고,
    한쪽만 지우면 「왜 이건 있고 저건 없지」가 된다. */
function ownDescription(platformId: string, seriesId: string, desc: string | null): string | null {
  if (!desc) return null;
  const twin = db.prepare(`SELECT id FROM url
    WHERE platform_id = ? AND series_id <> ? AND description = ?`)
    .all(platformId, seriesId, desc) as { id: string }[];
  if (!twin.length) return desc;
  db.prepare(`UPDATE url SET description = NULL WHERE id IN (${twin.map(() => "?").join(",")})`)
    .run(...twin.map(t => t.id));
  return null;
}

export function findOrMakeUrl(p: {
  platformId: string; seriesId: string; listUrl: string; appUrl: string | null;
  mediaType: string; title: string; description: string | null;
  coverUrl: string | null; coverAspect: number | null;
  episode: string | null;
}): string {
  const had = db.prepare("SELECT id, description FROM url WHERE platform_id = ? AND series_id = ?")
    .get(p.platformId, p.seriesId) as { id: string; description: string | null } | undefined;
  /* 이미 있는 줄은 그대로 쓴다. 다만 **소개글이 비어 있으면 채운다** — 소개글을 읽기
     전에 담긴 줄들이 있고, 그것들이 영영 비어 있을 이유가 없다. 이미 든 값은 덮지
     않는다: 그건 누군가 고쳐 둔 것일 수 있다. */
  if (had) {
    if (!had.description && p.description) {
      const own = ownDescription(p.platformId, p.seriesId, p.description);
      if (own) db.prepare("UPDATE url SET description = ? WHERE id = ?").run(own, had.id);
    }
    return had.id;
  }
  const id = newId("u");
  db.prepare(`INSERT INTO url
      (id, platform_id, series_id, list_url, app_url, media_type,
       title, description, cover_url, cover_aspect, episode, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, p.platformId, p.seriesId, p.listUrl, p.appUrl, p.mediaType,
      p.title, ownDescription(p.platformId, p.seriesId, p.description),
      p.coverUrl, p.coverAspect, p.episode, Date.now());
  return id;
}

/* 내 폴더에만 넣을 수 있는 것이 아니다 — **함께 고치는 폴더**에도 넣는다.
   그때 이어지는 곳은 내 쪽 비추는 폴더가 아니라 **원본 폴더**다. 그래야 주인에게도,
   함께 쓰는 다른 사람에게도 같은 한 곳에 담긴다. */
export function setWorkFolders(userId: string, workId: string, folderIds: string[]): void {
  db.prepare("DELETE FROM work_folder WHERE work_id = ?").run(workId);
  const ins = db.prepare("INSERT OR IGNORE INTO work_folder(work_id, folder_id) VALUES(?,?)");
  for (const f of folderIds) if (mayFile(userId, f)) ins.run(workId, f);
}

export type ShareMode = "none" | "all" | "some";
/** 공개한 폴더를 친구가 가져갈 수 있는 방식 */
/** 퍼가기 갈래 — **쉼표로 이은 집합**이다.

    한때 다섯 중 하나였고(`none|copy|mirror|both|edit`) 타입도 그렇게 적혀 있었는데,
    once(8) 에서 켜고 끄는 방식으로 옮기면서 값이 `"copy,mirror"` 같은 모양이 되었다.
    그런데 타입은 그대로여서, 실제로 담기는 값이 타입에 **하나도 안 맞는데** 여기저기
    `as TakeMode` 로 우겨 넣고 있었다 — 타입이 거짓말을 하면 없느니만 못하다.

    지금 설 수 있는 값은 여섯이다:
      일반 폴더 — "" · "copy" · "mirror" · "copy,mirror"
      공유 폴더 — "edit"
    (섞이지 않는다는 것은 server.ts 의 validTake 가 지킨다.) */
export type TakeMode = string;
/* 함께 고치는 사이라면 담아가는 것도 된다 — 가장 너그러운 갈래다.
   같이 꾸린 폴더에서 마음에 드는 것을 내 것으로 만드는 일은 그 폴더의 쓰임 그대로다. */
/* **셋은 서로 독립이다.** 예전에는 하나만 고를 수 있어서 「둘 다」라는 갈래를 따로 두었고,
   「폴더 공유」는 담아가기·미러링을 저절로 포함했다. 이제는 켜고 끄는 셋이라 그럴 필요가 없다 —
   담아가기만, 미러링만, 셋 다, 무엇이든 된다. 셋이 다 꺼져 있으면 비공개다.

   값은 쉼표로 이은 글자다("copy,mirror"). 칸을 셋으로 늘리지 않은 까닭은 이 값을 읽는
   자리가 마흔 곳이 넘는데, 그 전부가 아래 세 함수를 지나기 때문이다 — 여기만 바꾸면 된다. */
export const hasTake = (t: TakeMode, flag: string): boolean =>
  String(t ?? "").split(",").includes(flag);

export const canCopy = (t: TakeMode): boolean => hasTake(t, "copy");
/* 함께 고치는 폴더도 상대 쪽에서는 **비추는 폴더**로 선다 — 내 목록에 들어오는 길이
   하나뿐이어야 하고, 그 길은 이미 미러링이 내고 있다. 다른 것은 고칠 수 있느냐뿐이다. */
export const canMirror = (t: TakeMode): boolean => hasTake(t, "mirror");
/** 이 폴더를 볼 수 있는 사람은 **넣고 뺄 수도** 있다 */
export const canEdit = (t: TakeMode): boolean => hasTake(t, "edit");

/** 그 폴더를 함께 쓰는 사람들 — 주인과, 주인이 보여 주기로 한 친구들.

    함께 고치기는 "볼 수 있는 사람 = 고칠 수 있는 사람" 이다. 볼 사람을 이미 골라 두었는데
    고칠 사람을 또 고르게 하면 두 목록이 어긋날 자리가 생긴다. */
function folderMembers(folderId: string): { owner: string; all: string[] } | null {
  const f = db.prepare(`SELECT user_id, share_mode, take_mode
    FROM folder WHERE id = ?`).get(folderId) as any;
  if (!f || !canEdit((f.take_mode ?? "copy") as TakeMode)) return null;
  const owner = f.user_id as string;
  if (f.share_mode === "all") {
    const rows = db.prepare("SELECT friend_id FROM friend WHERE user_id = ?").all(owner) as any[];
    return { owner, all: [owner, ...rows.map(r => r.friend_id)] };
  }
  if (f.share_mode === "some") {
    // **수락한 사람만** 넣고 뺄 수 있다 — 이름만 올라 있는 사람은 아직 참여자가 아니다
    const rows = db.prepare("SELECT viewer_id FROM folder_share WHERE folder_id = ? AND state = 'ok'")
      .all(folderId) as any[];
    return { owner, all: [owner, ...rows.map(r => r.viewer_id)] };
  }
  return { owner, all: [owner] };          // 공개하지 않았으면 나뿐이다
}

/** 내가 이 폴더에 작품을 넣고 뺄 수 있는가 */
const mayFile = (userId: string, folderId: string): boolean => {
  const f = db.prepare("SELECT user_id, mirror_owner FROM folder WHERE id = ?").get(folderId) as any;
  if (!f) return false;
  /* **비추는 폴더에는 담지 않는다.** 그건 남의 폴더를 보여 주는 껍데기일 뿐이라,
     거기 걸면 나만 보이고 주인에게도 함께 쓰는 사람에게도 가지 않는다.
     함께 고치는 폴더에 넣을 때 이어지는 곳은 늘 **원본 폴더**다.

     겹쳐서 대체된 작품도 이 규칙에 걸린다 — 화면에서는 그 폴더 안에 있는 것처럼 보이지만
     실제로 건 사람은 친구이고, 그 이음줄은 **건 사람만** 풀 수 있다. */
  if (f.mirror_owner) return false;
  if (f.user_id === userId) return true;
  return !!folderMembers(folderId)?.all.includes(userId);
};

export type Folder = {
  id: string; name: string; emoji: string; ord: number;
  /** 자주 여는 폴더 — 내 목록에서 위로 온다. 남에게는 보이지 않는다. */
  starred: boolean;
  /** 별을 **켠 때**. 꺼져 있으면 0. 즐겨찾기 창이 켠 차례대로 세울 때 쓴다. */
  starredAt: number;
  share: { mode: ShareMode; with: string[] };
  take: TakeMode;
  /** 함께 고치는 폴더에 이름이 오른 사람들과 그 상태 (pending · ok) */
  people: { id: string; state: string }[];
  /** 남의 폴더를 비추는 중이면 원본을 가리킨다. 내 폴더면 null. */
  mirror: { owner: string; folder: string } | null;
};

/* 폴더를 읽는 길은 하나다. 목록이든 한 줄이든 조건만 다르다 —
   한 줄 보려고 목록을 통째로 훑고 버리는 일이 없게. */
function folderRows(where: string, ...args: unknown[]): Folder[] {
  const rows = db.prepare(`SELECT id, name, emoji, ord, share_mode, take_mode, starred,
      mirror_owner, mirror_folder FROM folder WHERE ${where} ORDER BY ord, rowid`)
    .all(...args) as any[];
  if (!rows.length) return [];
  const marks = rows.map(() => "?").join(",");
  const pairs = db.prepare(
    `SELECT folder_id, viewer_id, state FROM folder_share WHERE folder_id IN (${marks})`)
    .all(...rows.map(r => r.id)) as { folder_id: string; viewer_id: string; state: string }[];
  /* 이름만 필요한 곳(share.with)과 상태까지 필요한 곳(people)이 있는데 밑감은 같은 줄이다.
     한 번만 모으고 이름 쪽은 거기서 뽑아 쓴다. */
  const st = new Map<string, { id: string; state: string }[]>();
  for (const x of pairs)
    (st.get(x.folder_id) ?? st.set(x.folder_id, []).get(x.folder_id)!)
      .push({ id: x.viewer_id, state: x.state ?? "ok" });
  return rows.map(r => {
    /* 함께 고치는 폴더의 참여자와 그 상태. 주인이 「공유자」 창에서 보는 값이다. */
    const people = st.get(r.id) ?? [];
    return {
      id: r.id, name: r.name, emoji: r.emoji, ord: r.ord,
      starred: !!r.starred, starredAt: r.starred || 0,
      share: { mode: (r.share_mode ?? "none") as ShareMode, with: people.map(p => p.id) },
      take: (r.take_mode ?? "copy") as TakeMode,
      people,
      mirror: r.mirror_owner && r.mirror_folder
        ? { owner: r.mirror_owner, folder: r.mirror_folder } : null,
    };
  });
}

export const listFolders = (userId: string): Folder[] => folderRows("user_id = ?", userId);
export const getFolder = (userId: string, id: string): Folder | null =>
  folderRows("user_id = ? AND id = ?", userId, id)[0] ?? null;

/** 별을 켜고 끈다. 내 폴더에만 켤 수 있다 — 남의 폴더 줄은 애초에 내 표에 없다.

    켜진 표시로 **1 이 아니라 켠 시각**을 담는다. 0 이 아니면 켜진 것이라는 규칙은
    그대로여서(`!!starred`) 읽는 쪽은 하나도 바뀌지 않고, 즐겨찾기 창은 이 값으로
    켠 차례를 세운다. 컬럼을 새로 만들지 않으니 옮겨 심을 것도 없다 — 예전에 1 로
    켜 둔 줄은 가장 이른 시각이 되어 자연히 맨 앞에 선다. */
export const starFolder = (userId: string, folderId: string, on: boolean): boolean =>
  !!db.prepare("UPDATE folder SET starred = ? WHERE id = ? AND user_id = ?")
    .run(on ? Date.now() : 0, folderId, userId).changes;

/** 폴더 한 줄 만들기 — 새 폴더 · 담아가기 · 미러링이 모두 이 길로 온다 */
export function createFolder(userId: string, p: {
  name: string; emoji?: string; mirror?: { owner: string; folder: string };
}): Folder {
  const id = newId("f");
  const ord = (db.prepare("SELECT COALESCE(MAX(ord), 0) + 1 n FROM folder WHERE user_id = ?")
    .get(userId) as { n: number }).n;
  db.prepare(`INSERT INTO folder(id, user_id, name, emoji, ord, take_mode,
      mirror_owner, mirror_folder) VALUES(?,?,?,?,?,?,?,?)`)
    /* 빈 아이콘을 몰래 📁 로 바꾸지 않는다 — 이름만으로 세운 폴더는 아이콘이 없는 것이
       맞고, 그때 목록의 얼굴 자리에는 표지 넷이 선다. 몰래 채워 넣으면 만들 때와 고칠 때의
       잣대가 달라진다(고치는 쪽은 빈 값을 그대로 담는다). 둘 다 비는 일은 API 가 막는다. */
    .run(id, userId, p.name, p.emoji, ord,
      // 비추는 폴더는 내 것이 아니라 남에게 넘길 수 없다 (sharedView 도 걸러 낸다)
      /* 비추는 폴더는 내 것이 아니라 남에게 넘길 수 없다 (sharedView 도 걸러 준다).
         **빈 글자다.** 한때 "none" 이라 적었는데 그건 갈래가 다섯이던 때의 낱말이고,
         지금 값은 쉼표로 이은 집합이라 「아무것도 안 켬」은 빈 글자다. canCopy 들이
         모두 거짓을 내주어 눈에 띄지 않았을 뿐, 규칙 밖의 값이 표에 앉아 있었다. */
      /* 새 폴더는 비공개로 선다 — 화면과 같은 기본값이다. take 를 안 보낸 요청도
         열리지 않은 폴더가 되어야 한다(열리는 것은 늘 명시적인 선택). */
      "",
      p.mirror?.owner ?? null, p.mirror?.folder ?? null);
  return getFolder(userId, id)!;
}

/* 함께 쓰던 사람이 나가면 **그 사람이 걸어 둔 것도 함께 빠진다.**

   작품은 그 사람 목록에 그대로 남는다 — 빠지는 것은 이 묶음과의 이음줄뿐이다.
   그러지 않으면 주인은 이제 남이 된 사람의 작품을 계속 보게 되고, 나간 사람은 뺄
   권한이 없어 치우지도 못한다. 둘 다 손댈 수 없는 줄이 남는 셈이다. */
function dropContributions(folderId: string, userIds: string[]): number {
  if (!userIds.length) return 0;
  const marks = userIds.map(() => "?").join(",");
  return db.prepare(`DELETE FROM work_folder WHERE folder_id = ? AND work_id IN (
      SELECT id FROM work WHERE user_id IN (${marks}))`).run(folderId, ...userIds).changes;
}

/* 함께 쓰는 폴더에 **남이 걸어 둔 작품**을 통째로 읽는다.

   한때 부르는 쪽에서 번호만 뽑아 놓고 한 줄씩 getWork 로 다시 물었다 — 작품 한 편에
   질의 두 번이고, 그렇게 얻은 폴더 목록은 곧바로 덮어써 버려 온전히 버려지는 일이었다.
   첫 질의가 이미 줄 전체를 들고 있으니 그것으로 만든다. */
/** 남에게 넘기는 줄 — **상태는 들고 가지 않는다.**

    내가 다 봤다는 것은 나와 그 작품 사이의 일이라, 남의 화면에서는 그냥 「그 폴더에
    있는 한 편」이다. 그대로 넘기면 두 가지가 어긋난다: 받는 쪽의 「이용 완료 보이기」
    설정이 남의 작품을 감추고, 표지의 배지가 **남의 완료를 제 것처럼** 말한다.
    배지는 내가 다 본 주소에만 붙어야 한다.

    별점·본 횟수·마지막으로 연 때를 안 베끼는 것과 같은 잣대다 — 그 작품에 대한 것은
    넘기고, 그 사람과 작품 사이의 것은 넘기지 않는다. */
const asShared = <T extends { state: string }>(w: T): T => ({ ...w, state: "active" });

export function contributedWorks(folderId: string, who: { not?: string; only?: string }):
  (Work & { owner: string; ownerName: string })[] {
  /* 사람 표의 별칭이 usr 인 이유: u 는 url 표가 쓴다(WORK_COLS 가 그렇게 부른다). */
  const rows = db.prepare(`SELECT ${WORK_COLS}, usr.display_name AS who
    ${WORK_FROM}
    JOIN work_folder wf ON wf.work_id = w.id
    JOIN user usr ON usr.id = w.user_id
    WHERE wf.folder_id = ? AND w.state <> 'dropped' AND w.user_id ${who.only ? "=" : "<>"} ?
    ORDER BY w.added_at DESC`).all(folderId, who.only ?? who.not) as any[];
  /* 폴더 목록은 비워 둔다 — 부르는 쪽이 제 폴더 번호를 달아 주므로, 여기서 물어봐야
     그 자리에서 버려질 값이다. */
  return rows.map(r => asShared({ ...toWork(r, []), owner: r.user_id, ownerName: r.who ?? "이름 없음" }));
}

/** 그 폴더에 무언가 걸어 둔 사람들 — 주인은 빼고 */
const contributors = (folderId: string, ownerId: string): string[] =>
  (db.prepare(`SELECT DISTINCT w.user_id AS id FROM work_folder wf
    JOIN work w ON w.id = wf.work_id
    WHERE wf.folder_id = ? AND w.user_id <> ?`).all(folderId, ownerId) as any[]).map(r => r.id);

/** 나 혼자 이 폴더에서 손을 뗀다 — 걸어 둔 것을 걷어 간다 */
export const leaveFolder = (userId: string, folderId: string): number =>
  dropContributions(folderId, [userId]);

/** 퍼가기 권한을 정한다 — 비추고 있는 폴더에는 뜻이 없다 (내 것이 아니므로) */
export const setFolderTake = (folderId: string, take: TakeMode): void => {
  const was = db.prepare("SELECT user_id, take_mode FROM folder WHERE id = ?").get(folderId) as any;
  const old = (was?.take_mode ?? "copy") as TakeMode;
  const cut = was && canMirror(old) && !canMirror(take) ? connectedTo(folderId) : [];
  db.prepare("UPDATE folder SET take_mode = ? WHERE id = ?").run(take, folderId);
  /* 함께 고치기를 끄면 더는 함께 쓰는 폴더가 아니다 — 남들이 걸어 둔 것을 걷어 낸다 */
  if (was && canEdit(old) && !canEdit(take))
    dropContributions(folderId, contributors(folderId, was.user_id));
  /* 비추는 길이 닫히면 그쪽 폴더는 그 자리에서 빈다. 함께 쓰던 폴더였다면 그 말로 적는다 —
     "미러링이 꺼졌습니다" 는 그 사람이 겪은 일과 다르다. */
  if (cut.length) noticeBreak(folderId, canEdit(old) ? "함께 쓰기가 끝났습니다" : "미러링이 꺼졌습니다", cut);
};

/** 그 폴더를 누구에게 보여 줄지 정한다. mode 가 "some" 이 아니면 짝은 지운다. */
/* 이름을 지웠다 다시 올리면 처음부터다 — 그래서 지금 상태를 먼저 챙겨 두고 다시 심는다.
   **함께 고치는 폴더**에 새로 부른 사람은 pending 으로 시작한다. 수락해야 참여자가 된다.
   그냥 보여 주기만 하는 폴더는 수락할 것이 없으므로 곧바로 ok 다. */
export function setFolderShare(folderId: string, mode: ShareMode, viewers: string[],
                               needsAccept = false): void {
  const was = new Map((db.prepare("SELECT viewer_id, state FROM folder_share WHERE folder_id = ?")
    .all(folderId) as any[]).map(r => [r.viewer_id, r.state ?? "ok"]));
  const f = db.prepare("SELECT user_id, take_mode FROM folder WHERE id = ?").get(folderId) as any;
  /* 좁아지면서 **줄이 끊기는 사람**을 먼저 셈해 둔다 — 아래에서 folder_share 를 지우고 나면
     누가 닿아 있었는지 물어볼 데가 없다. 넓히는 쪽(some → all)은 아무도 잃지 않는다. */
  const cut = mode === "all" ? []
    : connectedTo(folderId).filter(id => mode !== "some" || !viewers.includes(id));
  db.prepare("UPDATE folder SET share_mode = ? WHERE id = ?").run(mode, folderId);
  db.prepare("DELETE FROM folder_share WHERE folder_id = ?").run(folderId);

  /* 명단에서 빠진 사람이 걸어 둔 것도 함께 걷는다 — 모두에게 열어 두는 폴더로 바꾸거나
     아예 닫는 것도 "이 사람들과 함께 쓰던 것을 그만둔다" 는 뜻이다. */
  if (f && canEdit(f.take_mode as TakeMode)) {
    const keep = mode === "some" ? new Set(viewers) : new Set<string>();
    const gone = contributors(folderId, f.user_id).filter(id => !keep.has(id));
    dropContributions(folderId, gone);
  }

  if (mode === "some") {
    const ins = db.prepare("INSERT OR IGNORE INTO folder_share(folder_id, viewer_id, state) VALUES(?,?,?)");
    for (const v of new Set(viewers)) ins.run(folderId, v, was.get(v) ?? (needsAccept ? "pending" : "ok"));
  }
  noticeBreak(folderId, "공개가 끝났습니다", cut);
}

/** 명단에 몇 사람을 더 부른다 — 공개 대상을 통째로 다시 쓰지 않고 **더하기만** 한다 */
export function inviteToFolder(folderId: string, add: string[]): number {
  const f = db.prepare("SELECT take_mode, share_mode FROM folder WHERE id = ?").get(folderId) as any;
  if (!f || f.share_mode !== "some") return 0;
  const ins = db.prepare("INSERT OR IGNORE INTO folder_share(folder_id, viewer_id, state) VALUES(?,?,?)");
  // 함께 고치는 폴더는 수락을 거쳐야 하고, 보여 주기만 하는 폴더는 수락할 것이 없다
  const state = canEdit((f.take_mode ?? "copy") as TakeMode) ? "pending" : "ok";
  let n = 0;
  for (const v of new Set(add)) n += ins.run(folderId, v, state).changes;
  return n;
}

/** 한 사람만 끊는다 — 주인이 「공유자」 창에서 누른다 */
export function unlinkFromFolder(folderId: string, userId: string): boolean {
  const f = db.prepare("SELECT user_id, share_mode FROM folder WHERE id = ?").get(folderId) as any;
  if (!f || f.user_id === userId) return false;
  const had = connectedTo(folderId).includes(userId);
  const row = db.prepare("DELETE FROM folder_share WHERE folder_id = ? AND viewer_id = ?")
    .run(folderId, userId).changes;
  /* 「모든 친구에게」 연 폴더는 명단이 없어 한 사람만 뺄 수 없다 —
     그 폴더에서 끊으려면 공개 대상을 먼저 좁혀야 한다. */
  if (!row && f.share_mode !== "some") return false;
  dropContributions(folderId, [userId]);
  if (had) noticeBreak(folderId, "연결이 해제되었습니다", [userId]);
  return true;
}

/* ── 끊겼다는 소식 ───────────────────────────────────────── */

/** 지금 이 폴더에 **줄이 닿아 있는** 사람들 — 비추고 있거나, 수락하고 함께 쓰거나 */
function connectedTo(folderId: string): string[] {
  const a = db.prepare("SELECT user_id AS id FROM folder WHERE mirror_folder = ?")
    .all(folderId) as any[];
  const b = db.prepare("SELECT viewer_id AS id FROM folder_share WHERE folder_id = ? AND state = 'ok'")
    .all(folderId) as any[];
  return [...new Set([...a, ...b].map(r => r.id))];
}

/** 끊겼다고 적어 둔다. `who` 를 주면 그 사람들에게만, 안 주면 닿아 있던 모두에게. */
export function noticeBreak(folderId: string, reason: string, who?: string[]): number {
  const f = db.prepare(`SELECT f.name, f.emoji, f.user_id, u.display_name AS who
    FROM folder f JOIN user u ON u.id = f.user_id WHERE f.id = ?`).get(folderId) as any;
  if (!f) return 0;
  const ids = (who ?? connectedTo(folderId)).filter(id => id && id !== f.user_id);
  if (!ids.length) return 0;
  const ins = db.prepare(`INSERT INTO folder_notice
    (id, user_id, folder_id, name, emoji, owner_name, reason, created_at)
    VALUES(?,?,?,?,?,?,?,?)`);
  const now = Date.now();
  for (const id of new Set(ids))
    ins.run(newId("n"), id, folderId, f.name, f.emoji, f.who ?? "이름 없음", reason, now);
  return ids.length;
}

export type Notice = {
  id: string; folder: string | null; name: string; emoji: string;
  ownerName: string; reason: string; at: number; read: boolean;
};

/** 내게 온 소식. 읽은 것도 함께 준다 — 지우기 전에는 다시 볼 수 있어야 한다. */
export function folderNotices(userId: string): Notice[] {
  return (db.prepare(`SELECT * FROM folder_notice WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 50`).all(userId) as any[])
    .map(r => ({ id: r.id, folder: r.folder_id, name: r.name, emoji: r.emoji,
                 ownerName: r.owner_name, reason: r.reason, at: r.created_at, read: !!r.read_at }));
}

/** 읽음으로 둔다 — 목록을 연 순간 붉은 숫자가 사라진다 */
export const readNotices = (userId: string): number =>
  db.prepare("UPDATE folder_notice SET read_at = ? WHERE user_id = ? AND read_at IS NULL")
    .run(Date.now(), userId).changes;

/** 이미 읽은 소식을 걷어 낸다 — 앱을 새로 열 때 한 번 부른다.

    소식은 **한 번 읽으면 할 일이 끝난다.** 읽고 나서 또 「치우기」를 누르게 하면 같은
    일을 두 번 시키는 셈이라, 목록을 열어 본 것으로 처리를 갈음하고 다음에 열 때 걷는다.
    바로 지우지 않는 이유는 **보고 있는 목록이 눈앞에서 사라지면 안 되기** 때문이다. */
export const sweepNotices = (userId: string): number =>
  db.prepare("DELETE FROM folder_notice WHERE user_id = ? AND read_at IS NOT NULL")
    .run(userId).changes;

/** 내가 받은 폴더 초대 — 아직 수락도 거절도 안 한 것들 */
export function folderInvites(userId: string): {
  folder: string; name: string; emoji: string; owner: string; ownerName: string; count: number;
}[] {
  return (db.prepare(`
    SELECT f.id, f.name, f.emoji, f.user_id AS owner, u.display_name AS who,
           (SELECT COUNT(*) FROM work_folder wf WHERE wf.folder_id = f.id) AS n
    FROM folder_share fs
    JOIN folder f ON f.id = fs.folder_id
    JOIN user u ON u.id = f.user_id
    WHERE fs.viewer_id = ? AND fs.state = 'pending' AND f.take_mode = 'edit'
    ORDER BY f.rowid DESC`).all(userId) as any[])
    .map(r => ({ folder: r.id, name: r.name, emoji: r.emoji,
                 owner: r.owner, ownerName: r.who ?? "이름 없음", count: r.n }));
}

/** 초대를 받아들인다 — 참여자가 되고, 내 폴더 목록에 그 폴더가 선다 */
export function acceptFolder(userId: string, folderId: string): Folder | null {
  const r = db.prepare("UPDATE folder_share SET state = 'ok' WHERE folder_id = ? AND viewer_id = ? AND state = 'pending'")
    .run(folderId, userId);
  if (!r.changes) return null;
  const src = db.prepare("SELECT user_id, name, emoji FROM folder WHERE id = ?").get(folderId) as any;
  if (!src) return null;
  /* 수락하면 **곧바로 내 목록에 선다.** 따로 찾아 들어가 미러링을 누르게 하면,
     수락했는데 아무 일도 안 일어난 것처럼 보인다. 이미 있으면 그대로 둔다. */
  const had = db.prepare("SELECT id FROM folder WHERE user_id = ? AND mirror_folder = ?")
    .get(userId, folderId) as any;
  if (had) return getFolder(userId, had.id);
  return createFolder(userId, { name: src.name, emoji: src.emoji,
    mirror: { owner: src.user_id, folder: folderId } });
}

/** 초대를 물린다 — 이름이 명단에서 지워진다 */
export const declineFolder = (userId: string, folderId: string): boolean =>
  !!db.prepare("DELETE FROM folder_share WHERE folder_id = ? AND viewer_id = ? AND state = 'pending'")
    .run(folderId, userId).changes;

/** 내가 남의 작품을 어떻게 보고 있는지 — 한 번에 다 읽어 온다 */
export function seenByMe(userId: string): Map<string, { seen: number; opened: number | null }> {
  const rows = db.prepare("SELECT work_id, seen_at, opened_at FROM work_seen WHERE user_id = ?")
    .all(userId) as any[];
  return new Map(rows.map(r => [r.work_id, { seen: r.seen_at, opened: r.opened_at }]));
}

/** 눌러 봤다(붉은 점 끄기) · 보러 갔다(차례 올리기). opened 는 한 번 적히면 갱신된다. */
export function markSeen(userId: string, workId: string, opened: boolean): void {
  const now = Date.now();
  db.prepare(`INSERT INTO work_seen(user_id, work_id, seen_at, opened_at) VALUES(?,?,?,?)
    ON CONFLICT(user_id, work_id) DO UPDATE SET
      opened_at = COALESCE(excluded.opened_at, work_seen.opened_at)`)
    .run(userId, workId, now, opened ? now : null);
}

export const newId = (prefix: string): string =>
  prefix + Date.now().toString(36) + Math.trunc(Math.random() * 1e6).toString(36);

/* ── 친구 ────────────────────────────────────────────────── */
export type Friend = { id: string; displayName: string; since: number;
                       sharedFolders: number; starred: boolean };

export function listFriends(userId: string): Friend[] {
  /* 세는 것은 "그 친구가 공개한 폴더" 가 아니라 **내가 열어 봤을 때 실제로 서는 폴더** 다.
     조건이 sharedView 와 「친구 폴더 보기」 길목의 그것과 한 줄씩 맞아야 한다 —
     어긋나면 목록에는 5개라 적어 놓고 눌러 보면 4개가 나온다.

     ① 고른 친구에게만 연 폴더는 짝이 있는 사람에게만 보이고,
     ② 비추고 있는 폴더는 다시 공개하지 않으며(받은 것을 또 남에게 넘기지 않는다),
     ③ 함께 쓰는 폴더는 이미 상대의 폴더 탭에 제 줄로 서 있어 여기 또 나오지 않는다. */
  return (db.prepare(`
    SELECT u.id, u.display_name, f.created_at, f.starred,
           (SELECT COUNT(*) FROM folder fo WHERE fo.user_id = u.id
              AND fo.mirror_folder IS NULL AND fo.take_mode <> 'edit' AND (
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
  /* 함께 고치는 폴더에는 **누가 넣었든** 다 담긴다. 그 폴더만 주인 말고 다른 사람의
     작품까지 모으고, 나머지는 여느 때처럼 주인 것만 본다. */
  const shared = folders.filter(f => canEdit(f.take)).map(f => f.id);
  const sMarks = shared.map(() => "?").join(",");
  /* **이용 완료도 낸다.** 한때 살아 있는 것만 냈는데, 그러면 폴더에 그대로 두었는데도
     내가 다 봤다는 이유만으로 그 작품이 친구 화면에서 말없이 사라졌다 — 폴더에서 뺀
     적이 없는데 빠진 셈이다. 내려두는 것은 **내 목록의 결정**이지 폴더를 어떻게 꾸릴지의
     결정이 아니다. 휴지통은 다르다: 그건 폴더에서도 치우겠다는 뜻이라 내지 않는다. */
  const rows = db.prepare(`
    SELECT DISTINCT ${WORK_COLS}
    ${WORK_FROM}
    JOIN work_folder wf ON wf.work_id = w.id
    WHERE w.state <> 'dropped' AND wf.folder_id IN (${marks})
      AND (w.user_id = ?${shared.length ? ` OR wf.folder_id IN (${sMarks})` : ""})
    ORDER BY w.last_at DESC`).all(...ids, ownerId, ...shared) as any[];
  const links = db.prepare(`SELECT work_id, folder_id FROM work_folder
    WHERE folder_id IN (${marks})`).all(...ids) as { work_id: string; folder_id: string }[];
  const byWork = new Map<string, string[]>();
  for (const l of links) {
    if (!byWork.has(l.work_id)) byWork.set(l.work_id, []);
    byWork.get(l.work_id)!.push(l.folder_id);
  }
  /* 누구 것인지 함께 넘긴다 — 받는 쪽은 남이 넣은 작품을 고칠 수 없고, 제 캘린더에도
     올리지 않는다 (README 「함께 고치는 폴더」). */
  return {
    folders,
    works: rows.map(r => asShared({ ...toWork(r, byWork.get(r.id) ?? []), owner: r.user_id })),
  };
}

/** **한 사람에게 같은 작품은 한 줄** — 표가 지킨다.

    휴지통만 여러 줄이다: 담았다 버린 일은 저마다 다른 판단이고, 공유 폴더에서 온
    같은 작품을 따로 버릴 수도 있어야 한다.

    스키마가 아니라 여기서 세우는 까닭은 **차례** 때문이다. 옛 파일에는 겹친 줄이
    남아 있을 수 있어, 합치기(once 12)보다 먼저 세우면 표를 만들다 죽는다. */
function keepOneRow(): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_work_live;
    DROP INDEX IF EXISTS idx_work_done;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_kept
      ON work(user_id, url_id) WHERE state <> 'dropped';`);
}
keepOneRow();

/* ── 초대 ────────────────────────────────────────────────── */
const INVITE_DAYS = 14;

/* **초대 코드는 진짜 난수여야 한다.**

   한때 `newId("i").slice(1, 11)` 였다. newId 는 「시각 + Math.random」이라, 그 열 글자 중
   **앞 여덟이 Date.now() 를 36진법으로 적은 것**이었다 — 실제로 흔들리는 것은 두 글자,
   많아야 1300 가지였다. 초대가 언제쯤 만들어졌는지만 알면(「방금 링크 만들었어」)
   나머지는 세어 볼 수 있는 크기다.

   이 코드를 맞히면 그 사람의 **친구가 된다** — 초대 수락은 주인에게 되묻지 않는다.
   Math.random 은 예측할 수 있는 난수이기도 하다(같은 프로세스에서 몇 개만 보면
   다음 값이 따라 나온다). 세션 토큰과 같은 randomBytes 를 쓴다. */
export function createInvite(userId: string): { code: string; expiresAt: number } {
  db.prepare("DELETE FROM invite WHERE user_id = ? OR expires_at < ?").run(userId, Date.now());
  const code = randomBytes(9).toString("base64url");     // 72비트 · 주소에 그대로 쓰는 글자만
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
