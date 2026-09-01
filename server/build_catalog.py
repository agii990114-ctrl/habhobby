"""요일 카탈로그 스냅샷을 만들어 데모에 심을 JS 조각으로 뽑는다.

실제 서비스에서는 이 작업이 하루 한 번 서버에서 돌고 DB에 들어간다.
데모(아티팩트)는 외부 요청이 막혀 있으므로, 같은 결과를 파일에 굽는다.
요일은 비트마스크로 저장한다 — 0비트=일 … 6비트=토. 주 2회 이상 연재작이 있으므로 단일 값은 쓸 수 없다.
"""
import gzip, json, sys, urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]   # 인덱스 = getDay()


def j(url, ref):
    q = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": ref, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(q, timeout=30) as r:
        b = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            b = gzip.decompress(b)
        return json.loads(b.decode("utf-8", "replace"))


def naver():
    out = {}
    for i, d in enumerate(DAYS):
        data = j(f"https://comic.naver.com/api/webtoon/titlelist/weekday?week={d}&order=user",
                 "https://comic.naver.com/webtoon")
        for t in data.get("titleList", []):
            e = out.setdefault(str(t["titleId"]), [t.get("titleName") or "", 0, 0])
            e[1] |= 1 << i
            if t.get("rest"):
                e[2] = 1                      # 휴재 플래그
    return out


def kakao():
    out = {}
    for i, d in enumerate(DAYS):
        data = j(f"https://gateway-kw.kakao.com/section/v1/timetables/days?placement=timetable_{d}",
                 "https://webtoon.kakao.com/")
        for sec in data.get("data", []):
            if sec.get("module") != "WEEKDAYS":
                continue                      # 요일 편성 섹션만 — 프로모션 혼입 방지
            for cg in sec.get("cardGroups", []):
                for card in cg.get("cards", []):
                    c = card.get("content") or {}
                    cid = c.get("id")
                    if not cid:
                        continue
                    e = out.setdefault(str(cid), [c.get("title") or "", 0, 0])
                    e[1] |= 1 << i
    return out


if __name__ == "__main__":
    stamp = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    cat = {"naver-webtoon": naver(), "kakao-webtoon": kakao()}
    for k, v in cat.items():
        rest = sum(1 for e in v.values() if e[2])
        multi = sum(1 for e in v.values() if bin(e[1]).count("1") > 1)
        print(f"{k}: {len(v)}편 · 주2회+ {multi}편 · 휴재 {rest}편", file=sys.stderr)

    blob = json.dumps(cat, ensure_ascii=False, separators=(",", ":"))
    with open("catalog.js", "w", encoding="utf-8") as f:
        f.write(f"/* 연재 요일 카탈로그 스냅샷 · {stamp}\n"
                f"   실서비스에서는 서버가 하루 1회 갱신하는 테이블. 데모는 같은 결과를 구워 넣는다.\n"
                f"   구조: {{플랫폼: {{시리즈ID: [제목, 요일비트마스크, 휴재]}}}}  비트 0=일 … 6=토 */\n"
                f"const CATALOG_DATE = \"{stamp}\";\n"
                f"const CATALOG = {blob};\n")
    print(f"catalog.js 생성 · {len(blob):,} bytes", file=sys.stderr)
