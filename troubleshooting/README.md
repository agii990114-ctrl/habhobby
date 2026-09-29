# Troubleshooting Log

Every incident that cost real time, why it happened, and what now keeps it from
happening again. Entries follow one shape:

> **Symptom** — what was seen · **Cause** — why · **Fix** — what changed (commit) ·
> **Prevention** — the rule or check that came out of it

Dates are 2026. Entries marked *(other PC)* were fixed in commits made from the
second workstation.

## Open issues

| Issue | Where |
| --- | --- |
| Backups sit on the same disk as the live database | [data](data-migrations.md#backups-taken-with-cp-missed-recent-changes) |
| `habhobby.db.bak` (pre-accounts) still fails in `copyLegacy()` | [data](data-migrations.md#backups-older-than-schema-7-could-not-be-restored) |
| Cloudflare's managed `robots.txt` overrides the repo's | [operations](operations-deployment.md#our-robotstxt-never-reached-crawlers) |
| Uploaded cover URLs are guessable and unauthenticated | [security](security.md#open-issues) |
| Two machines on one tunnel would split the data | [operations](operations-deployment.md#risk-two-machines-on-one-tunnel) |

## Index

### [Operations & deployment](operations-deployment.md)
- **Test server locked the production database** — an outage from a load test that opened the live DB. `b326873`
- **Redeploying dropped the live tunnel connection (530)** — a dead token hidden by an already-open connection. Sep 9–11
- **Tunnel connected but every request was 503** — routing lived in a file only the other PC had. `5232166`
- **`tunnel login` could not deliver the certificate** — use the dashboard token instead
- **Deploy succeeded but users saw the old UI** — Cloudflare's 4-hour browser cache; content-hashed URLs. `d0f5c99`
- **Our `robots.txt` never reached crawlers** — overridden at Cloudflare's edge
- **Risk: two machines on one tunnel**

### [Data & migrations](data-migrations.md)
- **Backups older than schema 7 could not be restored** — a migration out of order, and a guard that didn't stop. `05890c7`
- **A fresh database would not boot** — old migrations ran on a new schema; `LATEST_V`. `e32dbe4`
- **Index created before the table it indexes** — `e32dbe4`
- **Duplicate "watched" rows blocked a unique index** — dedupe first, choosing rows to delete. `9a266ba`
- **Backups taken with `cp` missed recent changes** — WAL mode; use `VACUUM INTO`. `05890c7`
- **Values outside the schema, and a type that lied** — `b0cf8d4`

### [Security](security.md)
- **Invite codes were mostly a timestamp** — guessable, and accepting needed no approval. `b0cf8d4`
- **No security headers at all** — `b0cf8d4`
- **The CSP silently disabled `<img onerror>` fallbacks** — hashes don't cover inline handlers. `050a879` *(other PC)*
- **Port 8080 was open to the whole local network** — plain HTTP around Cloudflare. `05890c7`
- **Invalid values were silently dropped instead of rejected** — 201/200 with the wrong value stored. `b0cf8d4`
- **Disabling Kakao login without breaking auth** — removing credentials would enable a shared account. `c4de7d9`

### [UI](ui.md)
- **A comment closed early and swallowed a CSS rule** — `7e26576`
- **A new class name collided with an existing one** — `.row`. `17fb4cf`
- **Two names for "danger" styling** — `bad` vs `danger`. `96e3f15`
- **Clearing a folder name did not clear it** — truthiness vs presence. `7e26576`
- **Selecting text and releasing outside closed the sheet** — `7e26576`
- **Rating stars looked empty, and clicks were lost** — `96e3f15`
- **Cancel in the rating dialog threw a `ReferenceError`** — `96e3f15`
- **A sheet with no way out on touch devices** — `b0cf8d4`
- **An icon that no longer existed** — `7e26576`
- **Archive header went stale while searching** — `7e26576`
- **Content jumped under the top bar when a sheet opened** — `2e07cf6` *(other PC)*
- **Opening domain settings and saving marked everything as manual** — `dd646a5` *(other PC)*

### [Ingestion & clients](ingestion-clients.md)
- **Share did nothing on Android** — activity flags for "finish immediately". `ca7f1ba` *(other PC)*
- **iPhone home-screen icon was a screenshot** — `apple-touch-icon`. `16f83fd` *(other PC)*
- **One share, three front doors** — decision moved to the server. `70227cb` *(other PC)*
- **A blog home page resolved to an address that doesn't exist** — `1ada85e` *(other PC)*
- **Site logos only worked for "domain" platforms** — `78be040` *(other PC)*
- **Covers from other sites blocked by hotlink protection** — no-referrer

### [Tooling & testing](tooling.md)
- **A crashed edit script truncated README.md** (the Korean design log, now `PROJECT.md`) — `de2d1c7`
- **Shell heredocs collapse `\\` into `\`**
- **`node -e "…"` inside Bash eats quotes and backticks**
- **A NUL byte made grep treat a source file as binary** — `c4de7d9`
- **Load test measured the wrong thing — twice** — `0515163`
- **Test harness gotchas**

## Adding an entry

Put it in the matching file under a `##` heading that names the symptom in plain
words ("Share did nothing on Android", not "Fix ShareActivity"). Include the date
and commit, then Symptom · Cause · Fix · Prevention. Add a line to the index
above, and to *Open issues* if it isn't fully resolved.
