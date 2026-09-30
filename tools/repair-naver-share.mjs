// 네이버웹툰 공유 주소(m.comic.naver.com/share/<해시>)로 담아 둔 작품을 작품 주소로 고친다.
//
//   node --no-warnings tools/repair-naver-share.mjs <DB 파일> [--apply]
//
// 예전에는 이 주소에서 작품 번호를 못 뽑아 앱 주소(webtoonkr://…)가 비었고, 「보러가기」가 웹 주소로
// 열렸다. 이제 새로 담는 것은 번호를 뽑는다(resolve.ts 의 expandNaverShare). 이 스크립트는 **이미 담아 둔
// 줄**의 series_id · list_url · app_url 을 같은 규칙으로 고친다. --apply 를 안 주면 보기만 한다.
// 같은 작품이 이미 있으면 그 줄로 합치되, 한 사람이 둘 다 들고 있으면 건드리지 않고 알린다.
import { DatabaseSync } from "node:sqlite";
import { expandNaverShare } from "../src/resolve.ts";

const [dbPath, flag] = process.argv.slice(2);
if (!dbPath) { console.error("사용법: node tools/repair-naver-share.mjs <DB 파일> [--apply]"); process.exit(1); }
const apply = flag === "--apply";
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");

const rows = db.prepare(`SELECT id, platform_id, series_id, list_url FROM url
  WHERE platform_id = 'naver-webtoon' AND list_url LIKE '%comic.naver.com/share/%'`).all();
console.log(`${rows.length}줄을 살펴봅니다${apply ? "" : " (보기만 — 고치려면 --apply)"}`);
for (const r of rows) {
  const fixed = await expandNaverShare(r.list_url);
  const m = /titleId=(\d+)/.exec(fixed);
  if (!m) { console.log(`  ✗ 번호를 못 읽음: ${r.list_url}`); continue; }
  const id = m[1];
  const app = `webtoonkr://contentList?version=2&league=WEBTOON&titleId=${id}`;
  const same = db.prepare("SELECT id FROM url WHERE platform_id = ? AND series_id = ? AND id <> ?").get(r.platform_id, id, r.id);
  if (same) {
    // 두 줄이 하나가 된다 — 한 사람이 둘 다 들고 있으면 합칠 수 없다(작품은 사람당 한 줄)
    const clash = db.prepare(`SELECT 1 FROM work a JOIN work b ON a.user_id = b.user_id
      WHERE a.url_id = ? AND b.url_id = ? AND a.state <> 'dropped' AND b.state <> 'dropped'`).get(r.id, same.id);
    if (clash) { console.log(`  ! 합칠 수 없음(같은 사람이 둘 다 보유): ${id}`); continue; }
    console.log(`  → 합침: ${r.id} → ${same.id} (titleId ${id})`);
    if (apply) { db.prepare("UPDATE work SET url_id = ? WHERE url_id = ?").run(same.id, r.id); db.prepare("DELETE FROM url WHERE id = ?").run(r.id); }
    continue;
  }
  console.log(`  ✓ ${r.list_url} → titleId ${id}`);
  if (apply) db.prepare("UPDATE url SET series_id = ?, list_url = ?, app_url = ? WHERE id = ?")
    .run(id, `https://comic.naver.com/webtoon/list?titleId=${id}`, app, r.id);
}
