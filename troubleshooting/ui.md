# UI (app.js · styles.css)

Most of these share one trait: **nothing errored.** CSS drops bad rules silently,
a wrong class name is not a runtime error, and a missing icon renders as empty
space. They were found by looking at the screen or reading the code.

---

## A comment closed early and swallowed a CSS rule

- **Date:** 2026-09-03 · **Fix:** `7e26576`
- **Symptom:** Option buttons that had been laid out in one row went back to a
  vertical stack.
- **Cause:** A comment ended with `*/` one line too soon. The leftover line was
  parsed as a selector, and the next rule's `{ … }` became that selector's body.
  `.opts.across` disappeared entirely.
  ```css
       … hover background leaked. */      ← comment ends here
       On narrow screens … */             ← parsed as a selector
  .opts.across { display: grid; … }      ← swallowed as its body
  ```
- **Fix:** Closed the comment correctly. Checked the file with a small
  brace/comment balance script.
- **Lesson:** when a fixed layout "comes back", check whether the rule still
  exists in the parsed stylesheet before re-fixing the layout.

---

## A new class name collided with an existing one

- **Date:** 2026-09-03 · **Fix:** `17fb4cf`
- **Symptom:** Hovering anywhere in the sharing settings highlighted the whole
  block.
- **Cause:** The new grid was named `.opts.row`. `.row` already meant "a clickable
  list row" and brought `:hover` background, padding and `cursor: pointer`.
- **Fix:** Renamed to `.opts.across`.
- **Lesson:** common words (`row`, `col`, `box`) are usually taken. Search the
  stylesheet before naming.

---

## Two names for "danger" styling

- **Date:** 2026-09-03 · **Fix:** `96e3f15`
- **Symptom:** A trash button that should have been red was not.
- **Cause:** `.btn` uses `bad`; `.mini-btn` uses `danger`. `btn danger` matched
  nothing.
- **Fix:** `btn bad`, and a comment at the rule naming both.

---

## Clearing a folder name did not clear it

- **Date:** 2026-09-03 · **Fix:** `7e26576`
- **Symptom:** Deleting a folder's name and saving kept the old name.
- **Cause:** `b.name?.trim() || null` turned `""` into `null`, and
  `COALESCE(?, name)` put the old name back. "Leave it" and "empty it" were
  distinguished by truthiness instead of presence.
- **Fix:** `typeof b[key] === "string" ? b[key].trim() : was`. Same fix for the
  icon, and `createFolder` stopped silently substituting `📁` for an empty icon.

---

## Selecting text and releasing outside closed the sheet

- **Date:** 2026-09-03 · **Fix:** `7e26576`
- **Symptom:** Dragging to select a folder name and letting go over the backdrop
  closed the popup.
- **Cause:** The browser fires `click` on the common ancestor of press and
  release — the backdrop — which read as "tapped the backdrop".
- **Fix:** Remember where the pointer went down; close only if both press and
  release were on the backdrop.

---

## Rating stars looked empty, and clicks were lost

- **Date:** 2026-09-03 · **Fix:** `96e3f15`
- **Symptom 1:** Selected stars were gold outlines, not filled.
- **Cause 1:** Color came from `.on` on the button; fill comes from `.on` on the
  SVG. Only the first was set.
- **Symptom 2:** After the fix, some clicks did nothing.
- **Cause 2:** `paintStar` rewrites `innerHTML`, and it ran on every `mouseover`.
  If the SVG under the pointer was replaced between press and release, the click
  was lost.
- **Fix:** Set both classes, and only repaint a star whose state actually changed.

---

## Cancel in the rating dialog threw a `ReferenceError`

- **Date:** 2026-09-03 · **Fix:** `96e3f15`
- **Symptom:** Cancel did nothing.
- **Cause:** `cancel: () => openWorkSettings(w.id)` — there is no `w` in
  `openRating` (it has `list` and `one`). Copied from an older call site.
- **Fix:** Callers pass `opts.back`; the default falls back to `one.id`.

---

## A sheet with no way out on touch devices

- **Date:** 2026-09-03 · **Fix:** `b0cf8d4`
- **Symptom:** On a phone, the new-folder type chooser showed no close or cancel
  control.
- **Cause:** Cancel was in `.link-row.wide-only` (visible only with a mouse), the
  header had `actions: false` (no touch-side button), and the close `✕` is also
  mouse-only. All three paths hidden at once.
- **Fix:** Removed `wide-only` from that row.
- **Check:** `matchMedia('(hover: hover) and (pointer: fine)')` in the mobile
  emulator.

---

## An icon that no longer existed

- **Date:** 2026-09-03 · **Fix:** `7e26576`
- **Symptom:** "Add to folder" had no icon.
- **Cause:** `icon("board")` — `board` had been removed from `ICONS` as unused.
  `icon()` returns an empty string for unknown names.

---

## Archive header went stale while searching

- **Date:** 2026-09-03 · **Fix:** `7e26576`
- **Symptom:** Searching inside a star group left the header naming that group
  while the results had already left it.
- **Cause:** Search repaints only the body to keep input focus.
- **Fix:** The repaint also updates header title, subtitle and back button.

---

## Content jumped under the top bar when a sheet opened

- **Date:** 2026-09-04 · **Fix:** `2e07cf6` (other PC)
- **Symptom:** On narrow screens, opening a popup hid the row just below the top
  bar.
- **Cause:** While a sheet is open the page is pinned and the bar switches from
  `sticky` to `fixed`. `sticky` keeps its space in the flow; `fixed` does not, so
  the content moved up by the bar's height (82 px → 16 px).
- **Fix:** Reserve the space with the already-measured `--bar-h`.

---

## Opening domain settings and saving marked everything as manual

- **Date:** 2026-09-04 · **Fix:** `dd646a5` (other PC)
- **Symptom:** Saving without changes turned a domain into a "hand-set" one, so it
  stopped following the site's own name and lost its site logo. Separately, a
  title typed in "Add URL" reset when a schedule button was pressed.
- **Cause:** Save always wrote overrides. The schedule buttons redraw the preview
  and read the title from the resolved data instead of the draft.
- **Fix:** Drop overrides equal to the base value; keep the input value in the
  draft.
