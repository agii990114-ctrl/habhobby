# Operations & Deployment

How HabHobby runs: a Node process in Docker on a home PC, published through a
Cloudflare Tunnel (`cloudflared` container). No inbound ports on the router, no
cloud VM. The SQLite database lives on the host in `data/` (bind-mounted).

---

## Test server locked the production database (outage)

- **Date:** 2026-09-02 · **Fix:** `b326873`
- **Symptom:** Production started failing with `disk I/O error`. The site was down
  for about two minutes.
- **Cause:** A load-test server started on port 8099 ignored the intended data
  directory and opened the **live** `data/habhobby.db`. SQLite's WAL lock can only
  be held cleanly by one writer process; the test process held it and the real
  server could no longer write.
- **Fix:** Killed the test process, restarted the container. `DB_PATH` and the
  covers directory now honour a `DATA_DIR` environment variable, so test
  instances get their own files. No data was lost.
- **Prevention:** Every test instance runs with its own `DATA_DIR`. Never load-test
  or create test accounts against production; use an isolated copy
  (`VACUUM INTO` a snapshot, point `DATA_DIR` at it).

---

## Redeploying dropped the live tunnel connection (HTTP 530)

- **Date:** 2026-09-09 → fixed 2026-09-11 · **Fix:** new `TUNNEL_TOKEN` in `.env`
- **Symptom:** After `docker compose up -d --build`, `kim5ing.cloud` returned
  **530**. The app container itself was healthy (200 inside the Docker network,
  correct asset hashes). Tunnel logs:
  `Register tunnel error from server side error="Unauthorized: Tunnel not found"`.
- **Cause:** The tunnel had been deleted and recreated as `habhobby_home` from the
  other PC. This PC's `.env` still held the **old** token (file dated Sep 2). The
  old `cloudflared` container kept working only because it was holding a
  connection it had registered **before** the tunnel was deleted. Recreating the
  container forced a fresh registration, which the dead token could not pass.
- **Ruled out:** The same deploy also added `--config /etc/cloudflared/config.yml`.
  Running the same token *without* `--config` failed identically, so the config
  flag was not the cause.
- **Fix:** Copied the new tunnel's token from the dashboard into `.env`
  (`TUNNEL_TOKEN=`) and restarted `cloudflared`. Four connections registered;
  site back to 200.
- **Prevention:**
  - A running tunnel can hide a dead credential. Before recreating the
    `cloudflared` container, confirm the token in `.env` matches the tunnel shown
    in the dashboard.
  - When a tunnel is recreated on one machine, update `.env` on every machine
    that runs a connector.
- **Where the token lives (new dashboard UI):** Zero Trust → Networks → Tunnels →
  the tunnel → **Add a connector** (there is no "Configure" button anymore) →
  Docker → the string after `--token`.

---

## Tunnel connected but every request was 503

- **Date:** 2026-09-06 · **Fix:** `5232166` (other PC)
- **Symptom:** `cloudflared` registered fine, yet every request returned 503.
- **Cause:** The tunnel is not dashboard-managed. Its remote config was empty
  (`/config` metric showed `version: -1`, a single "503" rule). Routing is decided
  by the **connecting side's** local config file — and that file existed only on
  the other PC. A token says *which* tunnel, not *where to send traffic*.
- **Fix:** Added `cloudflared/config.yml` to the repo with one catch-all rule:
  `service: http://habhobby:8080`. No hostnames in the rule — Cloudflare already
  only sends this tunnel the hostnames attached to it, and a hardcoded hostname
  would silently turn into 503 the day the domain changes.
- **Prevention:** The routing file is versioned with the code.

---

## `cloudflared tunnel login` could not deliver the certificate

- **Date:** 2026-09-11 · **Fix:** switched to the token method
- **Symptom:** Running `tunnel login` in a container printed an authorization URL,
  then exited with `Failed to fetch resource` and "Your browser will download the
  certificate instead."
- **Cause:** The automatic certificate fetch back into the container failed. The
  fallback is a manual `cert.pem` download in the browser — which, when approving
  from a phone, lands on the phone.
- **Fix:** Used the dashboard connector token instead (one string in `.env`).
- **Prevention:** For a remote-run home server, prefer the token flow over
  `tunnel login`.

---

## Deploy succeeded but users saw the old UI

- **Date:** 2026-09-01 · **Fix:** `d0f5c99` (content-hashed asset URLs)
- **Symptom:** New code deployed; browsers kept showing the old screens.
- **Cause:** The server sends `Cache-Control: no-cache`, but Cloudflare rewrote it
  for browsers to `max-age=14400` (4 hours).
- **Fix:** Asset URLs carry a content hash (`/app.js?v=<sha256-8>`), so a new
  build is a new URL. Static files also send an `ETag` and answer `304` when
  unchanged.
- **Gotcha:** The server keeps static files in an in-memory cache. Editing
  `public/*` has no effect until the process restarts.

---

## Our `robots.txt` never reached crawlers

- **Date:** 2026-09-03 · **Found after:** `b0cf8d4`
- **Symptom:** The container served our `robots.txt` (`Disallow: /`), but
  `kim5ing.cloud/robots.txt` returned Cloudflare's version (`Allow: /` with
  `Content-Signal: ai-train=no`).
- **Cause:** Cloudflare's **managed robots.txt** intercepts the path at the edge.
- **Status:** Open. `X-Robots-Tag: noindex, …` headers do pass through, so indexing
  is still blocked. To serve the repo's file, turn off managed robots.txt in the
  Cloudflare dashboard.
- **Note:** robots.txt is a request, not a lock. The real protection is that
  everything under `/api/` returns 401 without a session.

---

## Risk: two machines on one tunnel

- **Status:** Open (operational rule)
- Cloudflare allows several connectors on one tunnel and load-balances between
  them. Each machine has its **own** SQLite file, so requests would land on
  different data depending on which connector answers. Run a connector on one
  machine at a time; check the dashboard's Connectors list.
