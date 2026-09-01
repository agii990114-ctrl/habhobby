"""'연재상태를 매일 갱신해야 한다'의 실제 비용을 잰다.
질문: 요일 카탈로그 한 바퀴가 몇 요청 / 몇 초 / 몇 편인가. 작품 수에 비례하는가."""
import gzip, json, time, urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

def fetch(url, referer):
    h = {"User-Agent": UA, "Referer": referer, "Accept": "application/json,*/*",
         "Accept-Language": "ko-KR,ko;q=0.9", "Accept-Encoding": "gzip"}
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=30) as r:
        b = r.read()
        if r.headers.get("Content-Encoding") == "gzip": b = gzip.decompress(b)
        return len(b), json.loads(b.decode("utf-8", "replace"))

DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
KO = dict(zip(DAYS, "월화수목금토일"))

print("=" * 72)
print("네이버웹툰 요일 카탈로그 한 바퀴")
print("=" * 72)
t0, bytes_n, nav = time.time(), 0, {}
for d in DAYS:
    n, data = fetch(f"https://comic.naver.com/api/webtoon/titlelist/weekday?week={d}&order=user",
                    "https://comic.naver.com/webtoon")
    bytes_n += n
    for t in data.get("titleList", []):
        e = nav.setdefault(str(t["titleId"]), {
            "제목": t.get("titleName"), "요일": [],
            "휴재": t.get("rest"), "완결": t.get("finish"), "표지": bool(t.get("thumbnailUrl"))})
        e["요일"].append(KO[d])
t_nav = time.time() - t0
rest = [v for v in nav.values() if v["휴재"]]
print(f"  요청 7회 · {bytes_n/1024:.0f}KB · {t_nav:.1f}초")
print(f"  고유 작품 {len(nav)}편 · 휴재 {len(rest)}편 · 주2회+ {sum(1 for v in nav.values() if len(v['요일'])>1)}편")
print(f"  한 응답에 들어 있는 것: 제목·표지·요일·휴재·완결 → 개별 조회 불필요")
for tid, name in [("769209", "화산귀환(연재중)"), ("796152", "마루는 강쥐(완결)")]:
    hit = nav.get(tid)
    print(f"  · {name:18} 카탈로그에 {'있음 → ' + str(hit['요일']) if hit else '없음 → 단건 조회로 폴백'}")

print()
print("=" * 72)
print("카카오웹툰 요일 카탈로그 한 바퀴")
print("=" * 72)
t0, bytes_n, kw = time.time(), 0, {}
for d in DAYS:
    n, data = fetch(f"https://gateway-kw.kakao.com/section/v1/timetables/days?placement=timetable_{d}",
                    "https://webtoon.kakao.com/")
    bytes_n += n
    for sec in data.get("data", []):
        for cg in sec.get("cardGroups", []):
            for card in cg.get("cards", []):
                c = card.get("content") or {}
                if c.get("id"):
                    kw.setdefault(str(c["id"]), {"제목": c.get("title"), "요일": []})["요일"].append(KO[d])
t_kw = time.time() - t0
print(f"  요청 7회 · {bytes_n/1024:.0f}KB · {t_kw:.1f}초")
print(f"  고유 작품 {len(kw)}편 · 주2회+ {sum(1 for v in kw.values() if len(v['요일'])>1)}편")
for cid, name in [("2379", "템빨(연재중)"), ("1781", "바니와 오빠들(완결)")]:
    hit = kw.get(cid)
    print(f"  · {name:18} 카탈로그에 {'있음 → ' + str(hit['요일']) if hit else '없음 → 완결/비연재로 추론'}")

print()
print("=" * 72)
print("합계 — 하루 한 번 돌리는 비용")
print("=" * 72)
print(f"  요청 14회 · {t_nav + t_kw:.1f}초 · 커버 {len(nav) + len(kw):,}편")
print(f"  사용자 수와 무관 · 등록된 작품 수와도 무관 (전 카탈로그를 통째로 받으므로)")
