# Tooling & Testing

Problems in *how the work was done* rather than in the product. Several of these
produced wrong conclusions before they produced wrong code, so they are worth
knowing before debugging anything here.

---

## A crashed edit script truncated README.md

- **Date:** 2026-09-02 · **Fix:** `de2d1c7`
- **Symptom:** A commit deleted 2,157 lines of README.md.
- **Cause:** An edit script opened the file for writing, then died on an encoding
  error, leaving a half-written file that was committed.
- **Fix:** Restored from the previous revision.
- **Prevention:** Edit large files with exact string replacement (read → replace
  one anchor that must match exactly once → write), never by streaming a rewrite.

---

## Shell heredocs collapse `\\` into `\`

- **Date:** recurring, 2026-09-02 → 09-11
- **Symptom:** Scripts written through Bash heredocs produced broken regexes:
  `[\s\S]` became `[sS]`, and `"\\b"` became `"\b"` — a backspace character — so a word-boundary
  regex matched nothing. A dead-code scan reported **all 232 functions** as unused.
  A CSP hash regex matched no script tag.
- **Cause:** The shell layer collapses a double backslash to a single one, even in
  a quoted heredoc. If that single backslash then lands inside a JS string or
  template literal, it is consumed as an escape: `\s` becomes `s`. Two layers,
  each removing one backslash.
- **Prevention:**
  - Avoid backslashes in generated scripts: build regexes with `new RegExp` from
    concatenated strings, or tokenize without regex.
  - When a result looks too good or too bad (everything unused, nothing matched),
    suspect the tool first.

---

## `node -e "…"` inside Bash eats quotes and backticks

- **Symptom:** Code patched through `node -e` came out with every `"` removed, or
  constants empty (`const SCHEMA_WORK = ;`).
- **Cause:** Inside double quotes, Bash treats backticks as command substitution
  and consumes inner quotes.
- **Prevention:** Write the patch script to a file and run the file.

---

## A NUL byte made grep treat a source file as binary

- **Date:** 2026-09-02 · **Fix:** `c4de7d9`
- **Symptom:** `grep` on `src/server.ts` printed "Binary file matches".
- **Cause:** A literal NUL character used as a key separator (`keyOf`).
- **Fix:** Written as the escape `\u0000`.

---

## Load test measured the wrong thing — twice

- **Date:** 2026-09-02 · **Result:** `0515163`
- **Mistake 1:** Requests were sent without a session cookie, so each one went
  through the dev fallback and wrote to the database. Measured 437/s; the real
  figure was 613/s.
- **Mistake 2:** Errors at high concurrency were blamed on the server. They were
  socket exhaustion in the load tool; with `maxSockets: 4096` there were zero
  errors at 1,000 concurrent.
- **Real finding:** `platformView` re-read overrides, site names and hosts for each
  of ~17 platforms — 30+ queries per `/api/state`. Reading them once
  (`platformCtx`) raised throughput from 763/s to 971/s at concurrency 16.

---

## Test harness gotchas

- **Static files are cached in memory.** Edits to `public/*` don't show until the
  server restarts.
- **HttpOnly cookies can't be replaced from page JavaScript.** Switch accounts in
  tests with `POST /api/logout`, not by writing `document.cookie`.
- **Reusing a `DATA_DIR` across runs** caused signup collisions; start from a
  fresh directory or a `VACUUM INTO` snapshot.
- **A long-lived read-only SQLite handle** kept returning an old snapshot and
  missed later writes. Open a new connection per check.
- **Opening a WAL backup read-only creates `-shm` sidecars.** A scan with
  `includes(".bak")` also picked up `-shm`/`-wal` files and failed on
  "file is not a database". Filter them out.
- **Windows keeps the file locked until the child process exits.** Counting rows
  right after `kill()` failed; wait for the `exit` event.
- **Paths for SQLite.** `VACUUM INTO '/c/Users/…'` fails; use `C:/Users/…`.
- **Two titles with the same name are not the same title.** Manually entered works
  each get their own `url` row. A duplicate-check test that used manual entries
  "failed"; with real, shared URLs it passed.
