# Security

Baseline that was checked and is sound: session tokens are `randomBytes(32)`,
passwords use `scrypt` with a random salt and `timingSafeEqual`, login attempts
are rate-limited (429), every `/api/` route returns 401 without a session, every
query is scoped by `user_id`, and the app container runs as the unprivileged
`node` user. The domain resolves only to Cloudflare addresses; the home IP is not
published.

---

## Invite codes were mostly a timestamp

- **Date:** 2026-09-03 · **Fix:** `b0cf8d4` · **Severity:** high
- **Symptom:** Found in review.
- **Cause:** `createInvite` used `newId("i").slice(1, 11)`. `newId` is
  `Date.now().toString(36) + Math.random()…`, so **8 of the 10 characters were the
  creation time**. The remaining two came from `Math.random()` — roughly 1,300
  possibilities, from a predictable generator.
- **Impact:** Knowing roughly when a link was made ("I just sent you a link")
  shrinks the search to something countable. `/api/invites/:code` had no rate
  limit, and accepting a code calls `addFriend()` **without the owner's approval** —
  a guesser silently becomes the victim's friend and sees their public folders.
- **Fix:** `randomBytes(9).toString("base64url")` — 72 random bits, URL-safe.
- **Lesson:** a function that makes IDs is not a function that makes secrets.

---

## No security headers at all

- **Date:** 2026-09-03 · **Fix:** `b0cf8d4`
- **Cause:** Six separate `writeHead` call sites; none set CSP, `nosniff`,
  frame protection, or `Referrer-Policy`.
- **Fix:** One set of headers applied before routing, so 404s and 500s get them
  too: `Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy` / `-Resource-Policy: same-origin`,
  `X-Robots-Tag: noindex, …`. The single inline `<script>` in `index.html` is
  allowed by a SHA-256 hash computed from the file at boot.

---

## The CSP silently disabled `<img onerror>` fallbacks

- **Date:** introduced 2026-09-03 (`b0cf8d4`) · **Fix:** `050a879` (other PC)
- **Symptom:** When a site logo failed to load, the letter fallback never
  appeared.
- **Cause:** The fallback was an inline `onerror="…"` attribute. CSP script
  hashes apply to `<script>` blocks, **not** to inline event handlers, so the
  handler was blocked from the day the CSP went live. Nothing logged it visibly.
- **Fix:** Moved the handler into `app.js`, listening for `error` in the capture
  phase (the event does not bubble).
- **Lesson:** after adding a CSP, search for `on[a-z]+=` attributes; each one is now
  dead code.

---

## Port 8080 was open to the whole local network

- **Date:** since `d0f5c99` (Sep 1) · **Fix:** `05890c7` (Sep 11)
- **Symptom:** `http://192.168.0.41:8080/` returned 200 from another device on the
  same Wi-Fi — reaching the app without Cloudflare.
- **Cause:** `docker-compose.yml` published `"8080:8080"`, which binds
  `0.0.0.0`. The comment right above it said the port was kept "to view on
  **localhost** during development" — the comment and the syntax disagreed.
- **Impact:** Still behind login (401), but plain HTTP: logging in over that
  address sent the password and session cookie unencrypted across the LAN.
- **Fix:** `"127.0.0.1:8080:8080"`. The tunnel reaches `habhobby:8080` over the
  Docker network and does not need a host port at all.
- **Verified:** LAN address → connection refused; `127.0.0.1:8080` → 200;
  `kim5ing.cloud` → 200.

---

## Invalid values were silently dropped instead of rejected

- **Date:** 2026-09-03 · **Fix:** `b0cf8d4`
- **Symptom:** `POST /api/folders` with `take: "copy,edit"` returned **201**, but
  stored `"copy"`. `PATCH` with a mixed value returned **200** and changed
  nothing.
- **Cause:** `applyShare` skipped any `take` that failed `validTake` and carried
  on. The validator existed to prevent "what you chose ≠ what was saved", and
  skipping produced exactly that.
- **Fix:** `badTake(b)` rejects with 400; changing a folder's kind after creation
  is 403.
- **Lesson:** dropping bad input and rejecting it are different things — only one
  tells the caller.

---

## Disabling Kakao login without breaking auth

- **Date:** 2026-09-02 · **Fix:** `c4de7d9`
- **Trap:** Deleting the Kakao credentials from `.env` would make
  `configuredProviders()` empty, which switches on the local fallback — where
  every anonymous visitor shares **one** account (`provider_uid = "local"`).
- **Fix:** Keep the credentials; hide the button with `DISABLED_LOGINS=kakao`.

---

## Open issues

- **Guessable cover URLs.** `/covers/<workId>.jpg` is served without auth, and
  work IDs come from `newId()` (timestamp + `Math.random`). Only user-uploaded
  covers are affected; most covers are CDN links. Fixing it means renaming
  existing files.
- **The tunnel token is the key to the domain.** Anyone holding `TUNNEL_TOKEN`
  can attach a connector and receive the site's traffic. It lives only in
  `.env` (git-ignored). Rotate it in the dashboard if it leaks.
- **Backups share a disk with the live database.**
