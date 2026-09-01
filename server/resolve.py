"""공유 URL 하나만으로 제목·요일·연재상태를 얻을 수 있는가 — 실제로 돌려본다.

구조:
  1) URL → 플랫폼 + seriesId          (규칙, 네트워크 불필요)
  2) seriesId → 메타데이터             (플랫폼별 조회)
       네이버웹툰: 작품 단건 조회로 전부 나옴
       카카오웹툰: 단건 조회에 요일이 없어 '요일 카탈로그' 역조회 필요
"""
import gzip, json, re, sys, urllib.error, urllib.request
from urllib.parse import urlparse, parse_qs

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
DOW_EN = {"MONDAY": "월", "TUESDAY": "화", "WEDNESDAY": "수", "THURSDAY": "목",
          "FRIDAY": "금", "SATURDAY": "토", "SUNDAY": "일"}
DOW_KW = {"mon": "월", "tue": "화", "wed": "수", "thu": "목", "fri": "금", "sat": "토", "sun": "일"}


def fetch(url, referer=None):
    h = {"User-Agent": UA, "Accept": "application/json,*/*",
         "Accept-Language": "ko-KR,ko;q=0.9", "Accept-Encoding": "gzip"}
    if referer:
        h["Referer"] = referer
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=30) as r:
        b = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            b = gzip.decompress(b)
        return json.loads(b.decode("utf-8", "replace"))


# ── 1단계: URL → 플랫폼 + seriesId ────────────────────────────────
def identify(shared_url):
    u = urlparse(shared_url.strip())
    host = u.hostname.replace("www.", "") if u.hostname else ""
    q = parse_qs(u.query)

    if host.endswith("comic.naver.com"):
        tid = (q.get("titleId") or [None])[0]
        if tid:
            return "naver-webtoon", tid, (q.get("no") or [None])[0]

    if host.endswith("webtoon.kakao.com"):
        m = re.match(r"^/content/[^/]+/(\d+)", u.path)
        if m:
            return "kakao-webtoon", m.group(1), None

    return None, None, None


# ── 2단계-a: 네이버웹툰 — 단건 조회로 전부 해결 ─────────────────────
def resolve_naver(title_id):
    ref = f"https://comic.naver.com/webtoon/list?titleId={title_id}"
    info = fetch(f"https://comic.naver.com/api/article/list/info?titleId={title_id}", ref)
    lst = fetch(f"https://comic.naver.com/api/article/list?titleId={title_id}&page=1&sort=DESC", ref)
    latest = (lst.get("articleList") or [{}])[0]
    return {
        "제목": info.get("titleName"),
        "요일": [DOW_EN.get(d, d) for d in (info.get("publishDayOfWeekList") or [])],
        "연재상태": "완결" if info.get("finished") else ("휴재" if info.get("rest") else "연재중"),
        "표지": info.get("thumbnailUrl"),
        "최신회차": f"{latest.get('subtitle')} ({latest.get('serviceDateDescription')})",
        "총회차": lst.get("totalCount"),
        "요청수": 2,
    }


# ── 2단계-b: 카카오웹툰 — 요일 카탈로그를 미리 만들어두고 ID로 역조회 ──
_KW_CATALOG = None

def kw_catalog(force=False):
    """하루 1회 갱신하는 공용 테이블. 7요청으로 전 카탈로그."""
    global _KW_CATALOG
    if _KW_CATALOG is not None and not force:
        return _KW_CATALOG
    idx, reqs = {}, 0
    for en, ko in DOW_KW.items():
        data = fetch(
            f"https://gateway-kw.kakao.com/section/v1/timetables/days?placement=timetable_{en}",
            "https://webtoon.kakao.com/")
        reqs += 1
        for sec in data.get("data", []):
            for cg in sec.get("cardGroups", []):
                for card in cg.get("cards", []):
                    c = card.get("content") or {}
                    cid = str(c.get("id") or "")
                    if not cid:
                        continue
                    e = idx.setdefault(cid, {"제목": c.get("title"), "요일": []})
                    if ko not in e["요일"]:
                        e["요일"].append(ko)
    _KW_CATALOG = {"index": idx, "요청수": reqs}
    return _KW_CATALOG

def resolve_kakao(content_id):
    cat = kw_catalog()
    hit = cat["index"].get(str(content_id))
    ref = "https://webtoon.kakao.com/"
    det = fetch(f"https://gateway-kw.kakao.com/decorator/v2/decorator/contents/{content_id}", ref)
    d = det.get("data") or {}
    eps = fetch(f"https://gateway-kw.kakao.com/episode/v1/views/content-home/contents/"
                f"{content_id}/episodes?sort=-NO&offset=0&limit=1", ref)
    ep = ((eps.get("data") or {}).get("episodes") or [{}])[0]
    on_air = hit is not None
    return {
        "제목": d.get("title") or (hit or {}).get("제목"),
        "요일": (hit or {}).get("요일", []),
        "연재상태": "연재중" if on_air else "완결·비연재 (요일 카탈로그에 없음)",
        "표지": d.get("backgroundImage"),
        "최신회차": f"{ep.get('title')} ({(ep.get('serialStartDateTime') or '')[:10]})",
        "요청수": 2,
        "카탈로그요청수": cat["요청수"],
    }


def resolve(shared_url):
    plat, sid, ep = identify(shared_url)
    if not plat:
        return {"오류": "규칙 없는 URL — 북마크 폴백"}
    meta = resolve_naver(sid) if plat == "naver-webtoon" else resolve_kakao(sid)
    meta["플랫폼"], meta["seriesId"] = plat, sid
    if ep:
        meta["공유된회차"] = ep
    return meta


SAMPLES = [
    "https://comic.naver.com/webtoon/detail?titleId=769209&no=16",
    "https://comic.naver.com/webtoon/detail?titleId=758037&no=200",
    "https://comic.naver.com/webtoon/list?titleId=796152",
    "https://webtoon.kakao.com/content/%EB%B0%94%EB%8B%88%EC%99%80-%EC%98%A4%EB%B9%A0%EB%93%A4/1781",
    "https://webtoon.kakao.com/content/%ED%85%9C%EB%B9%A8/2379",
]

if __name__ == "__main__":
    urls = sys.argv[1:] or SAMPLES
    for u in urls:
        print("=" * 76)
        print(f"입력 URL: {u}")
        print("-" * 76)
        try:
            for k, v in resolve(u).items():
                print(f"  {k:14} {v}")
        except urllib.error.HTTPError as e:
            print(f"  실패 HTTP {e.code}")
        except Exception as e:
            print(f"  실패 {type(e).__name__}: {str(e)[:100]}")
        print()
