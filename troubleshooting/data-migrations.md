# Data & Migrations

Schema changes run through `once(n, fn)` in `src/db.ts`: if `PRAGMA user_version`
is already `>= n` the step is skipped, otherwise it runs and the version is set to
`n`. Two consequences drive most entries below:

1. Steps must appear **in numeric order** in the file.
2. `once()` bumps the version whenever `fn` returns — it cannot tell "done" from
   "gave up".

---

## Backups older than schema 7 could not be restored

- **Date:** found 2026-09-03, fixed 2026-09-11 · **Fix:** `05890c7`
- **Symptom:** Restoring a pre-v7 backup crashed the server at boot:
  `Error: no such column: o.url_id at once (src/db.ts)`. 7 of 16 backups were
  unusable at the time.
- **Cause — two bugs stacked:**
  1. **Order.** `once(7)` (split `work` into shared `url` + per-user `work`) sat
     at the end of the file, after `once(12)`. On a v6 file, `once(8)` ran first
     and set the version to 8, so `once(7)` was then "already past" and skipped
     forever. The next step touched `url_id` on the old table and crashed.
  2. **A guard that didn't stop.** `once(7)` refused to touch a non-empty `work`
     table ("better to stop than silently delete"). But `once()` bumped the
     version anyway, so the chain carried on and crashed. Moving it into place
     alone rescued only the one backup with zero rows.
- **Fix:** `once(7)` moved between 6 and 8, and rewritten to **migrate** rows
  instead of refusing:
  - one `url` row per `(platform_id, series_id)`, seeded from the first row seen;
  - each `work` row keeps its id, so `work_folder` and `work_seen` stay attached;
  - title / cover / episode are stored as per-user overrides only when they
    differ from the `url` row.
  It follows SQLite's documented table-rebuild order — create `work_new`, copy,
  drop `work`, rename `work_new` → `work`. Renaming the old table first would
  (since SQLite 3.26) rewrite `work_folder`'s `REFERENCES work` to point at the
  old name and leave a dangling reference after the drop.
- **Verification:** every backup restored into a temp `DATA_DIR` and booted:
  **21 of 22 boot**, row counts for `work` and `work_folder` unchanged.
- **Prevention:**
  - Migrations are frozen SQL. They do not call app functions
    (`findOrMakeUrl`, `newId`), which change over time and are declared later in
    the module anyway.
  - A migration never "returns early to refuse". It either migrates or throws —
    a throw leaves the version untouched.
- **Still open:** `habhobby.db.bak` (Aug 28, pre-accounts, 13 titles) fails in
  `copyLegacy()`, which still copies into the pre-split `work` shape.

---

## A fresh database would not boot

- **Date:** 2026-09-03 · **Fix:** `e32dbe4`
- **Symptom:** Starting with an empty `data/` directory crashed during migrations.
- **Cause:** A new file starts at version 0, so `once(1)`…`once(6)` ran. They were
  written for the old table shapes and referenced columns (such as `app_url`)
  that the new boot schema no longer creates.
- **Fix:** If the version is 0 **and** the `user` table is empty, stamp the file
  with `LATEST_V` and skip every migration — there is nothing to migrate.
- **Prevention:** When adding a `once(n)`, bump `LATEST_V` to `n`.

---

## Index created before the table it indexes

- **Date:** 2026-09-03 · **Fix:** `e32dbe4`
- **Symptom:** Old databases failed at boot on
  `CREATE UNIQUE INDEX … ON work(user_id, url_id)`.
- **Cause:** The index was declared in the boot schema, which runs before
  migrations. On an old file `work` had no `url_id` yet.
- **Fix:** `SCHEMA_WORK_INDEX` is executed after all `once()` steps.

---

## Duplicate "watched" rows blocked a unique index

- **Date:** 2026-09-03 · **Fix:** `9a266ba`
- **Symptom:** Adding `idx_work_done` (one watched row per user per title) would
  fail on any database that already had duplicates — and a failed index stops the
  server from starting.
- **Fix:** `once(10)` removes duplicates first, keeping the most recently finished
  row. The query picks rows **to delete** ("a newer one exists"), not rows to keep:
  "pick the survivor" has no tie-breaker and either keeps both or deletes both.
  ```sql
  DELETE FROM work WHERE state='watched' AND EXISTS (
    SELECT 1 FROM work o WHERE o.user_id=work.user_id AND o.url_id=work.url_id
      AND o.state='watched'
      AND ( COALESCE(o.state_at,0) >  COALESCE(work.state_at,0)
         OR (COALESCE(o.state_at,0) =  COALESCE(work.state_at,0) AND o.rowid > work.rowid) ))
  ```
- **Note:** `IS NOT DISTINCT FROM` was avoided — it needs SQLite 3.39+.

---

## Backups taken with `cp` missed recent changes

- **Date:** 2026-09-11 · **Documented in:** `05890c7`
- **Symptom:** The main database file was dated Sep 4 while
  `habhobby.db-wal` (791 KB) was dated Sep 11.
- **Cause:** The database runs in WAL mode. Recent writes sit in the `-wal` file
  until a checkpoint. Copying only `habhobby.db` while the server runs produces a
  backup that silently lacks those writes. Several pre-deploy backups were made
  this way.
- **Fix:** Take backups with `VACUUM INTO`, which writes a complete, consistent
  copy:
  ```bash
  docker exec habhobby node -e "new (require('node:sqlite').DatabaseSync)('/app/data/habhobby.db').exec(\"VACUUM INTO '/app/data/habhobby.db.bak-NAME'\")"
  ```
- **Still open:** all backups live on the same disk as the live database.

---

## Values outside the schema, and a type that lied

- **Date:** 2026-09-03 · **Fix:** `b0cf8d4`
- **Symptom:** None visible — found in review.
- **Cause:** `once(8)` changed `folder.take_mode` from one of five words to a
  comma-joined set (`"copy,mirror"`). But `createFolder` still wrote `"none"` for
  mirror folders, and `type TakeMode` still listed the five old words. Nine
  `as TakeMode` casts hid the mismatch.
- **Fix:** mirror folders get `""`; `once(9)` rewrites existing `"none"`;
  `TakeMode` is `string` with the legal values documented.
- **Lesson:** a type that no longer matches the data is worse than no type — the
  casts suppress exactly the error that would have caught it.
