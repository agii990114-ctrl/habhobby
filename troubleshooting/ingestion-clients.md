# Ingestion & Clients

How titles get in: a URL is shared (PWA share target, the Android app, or an iOS
Shortcut), the server resolves it to a site + series, reads the page's Open Graph
data once, and stores it in the shared `url` table.

---

## Share did nothing on Android

- **Date:** 2026-09-06 · **Fix:** `ca7f1ba` (other PC)
- **Symptom:** Tapping "Add to HabHobby" in the share sheet had no effect. The
  server showed the share key as never used.
- **Cause:** `ShareActivity` was declared with `windowNoDisplay` and `noHistory`.
  Both are meant for activities that finish immediately. This one waits 1–3 s for
  the server to fetch the page, so Android treated the invisible activity as done
  and killed it mid-request.
- **Fix:** Removed both flags; use a transparent window instead. Also, a wrong key
  (401) now opens the setup screen — before, it only showed a toast and there was
  no way back to re-enter the key.

---

## iPhone home-screen icon was a screenshot

- **Date:** 2026-09-06 · **Fix:** `16f83fd` (other PC)
- **Symptom:** "Add to Home Screen" on iOS showed a picture of the page instead of
  the app icon, despite five icons in the manifest.
- **Cause:** iOS ignores manifest icons and reads only `apple-touch-icon`.
- **Fix:** Added `apple-touch-icon.png`. The icon generator now separates "don't
  crop the background" (bleed) from "shrink into the safe area" (shrink), which
  `maskable` had bundled together.

---

## One share, three front doors

- **Date:** 2026-09-06 · **Fix:** `70227cb`, `f9ffc53`, `3d7b570` (other PC)
- **Risk:** The "should this be saved?" decision lived in the service worker. The
  Android app and iOS Shortcuts don't pass through it, so the same rule would
  have existed twice — and "it saves differently depending on which device you
  shared from" is the hardest kind of drift to notice.
- **Fix:** One server function (`intakeShared`) makes the decision for every
  path. The server also writes the message to show (`text`), so clients just
  display it; `fmt=text` returns only that line for callers with no UI. Share
  keys (`hhk_…`) live in their own table and can only add URLs — a leaked key
  cannot use the rest of the API.

---

## A blog home page resolved to an address that doesn't exist

- **Date:** 2026-09-04 · **Fix:** `1ada85e` (other PC)
- **Symptom:** A Naver blog home URL could not be added.
- **Cause:** On `section.blog.naver.com`, the path segment `BlogHome.naver` is a
  page name, but the parser read it as a user ID and built
  `blog.naver.com/BlogHome.naver` — a 404. The dead-page check then rejected the
  original URL.
- **Fix:** The parser returns `null` for `section.` hosts and path segments ending
  in `.naver`; the URL is left as-is.

---

## Site logos only worked for "domain" platforms

- **Date:** 2026-09-04 · **Fix:** `78be040` (other PC)
- **Symptom:** A Naver blog kept a generic green "B" mark instead of its real
  logo.
- **Cause:** Site logos were attached only to domain-derived platforms; built-in
  platforms were excluded on the assumption that our marks were better.
- **Fix:** One rule for all: if the site publishes a logo, use it.

---

## Covers from other sites blocked by hotlink protection

- **Date:** 2026-09-01 · **Fix:** `<meta name="referrer" content="no-referrer">`
- **Cause:** Many CDNs refuse images requested from another site, deciding by the
  `Referer` header.
- **Fix:** Send no referrer. As a side effect, our URL isn't disclosed to every
  CDN.
- **Constraint:** Covers are linked, never copied or re-hosted (copyright).
