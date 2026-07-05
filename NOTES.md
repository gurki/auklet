# notes

## known limitations

- **history is partly backfilled, partly live.** `auklet backfill` (also run on
  startup) pulls real history from Audible's stats endpoints: per-book **finish
  dates** and per-day/per-month **listening time** (years back). what it CANNOT
  reconstruct is per-book *session detail* (which book, exactly when, from/to
  position) before the watcher ran — that only accrues live via progress
  snapshots. library/wishlist add/remove history is also live-only (except
  `library-added`, back-dated from Audible's purchase/added date).

- **aggregate listening time is local-only.** `stats/aggregates` totals aren't
  per-book, so they don't map to an `audiobook.listen` item and aren't synced to
  Journey — they live in `listening_stats` and the `activity` view. finish
  markers and inferred sessions do sync.

- **false-negative progress ("unknown").** a book shows "unknown" when Audible
  reports position 0 and no finish for *that asin*. confirmed not a
  `time_remaining` artifact (position is genuinely 0). usual cause: the book was
  finished/started under a *different edition's asin* than the one now in the
  library (Audible keeps state per asin), or listened without cloud sync. see the
  relationships idea below.

- **position precision.** position comes from `duration − time_remaining` when
  Audible provides `time_remaining_seconds`, else from `percent_complete ×
  duration` (coarse on long books — ~minutes per 1%). session start/end times
  are bounded by the poll interval, so a session's real start can be off by up to
  one `PROGRESS_INTERVAL_S`.

- **session inference is a heuristic.** pauses shorter than `SESSION_GAP_S` stay
  in one session; longer gaps split. re-listens / large seeks backward produce a
  0 (clamped) delta for that step. because raw snapshots are retained, sessions
  are fully re-derivable (`derive-sessions --rebuild`) as the heuristic improves.
  invariant: summed session `listenedSec` == total observed position advance.

- **auth fragility.** Amazon login can require CAPTCHA/OTP (handled in the browser
  step) and may break when Amazon changes its flow. credentials live in
  `db/audible-auth.json` (gitignored) and are auto-refreshed.

- **full-fetch polling.** Audible has no incremental feed, so every poll fetches
  the entire library + wishlist. large libraries may want a longer
  `PROGRESS_INTERVAL_S` to be gentle on the api.

## ideas / deferred

- **edition-mismatch finishes.** match `stats/status/finished` events to library
  books via each item's \`relationships\` (other-edition asins), not just exact
  asin, to recover finishes that read "unknown" because a different edition was
  finished. auklet already exposes a signed \`apiGet\`, so this is now tractable.
- **exact last position.** \`POST /1.0/content/{asin}/licenserequest\` with the
  \`last_position_heard\` response group gives precise position (ms) vs the
  percent-derived estimate. now easy — the signed \`apiGet\` helper exists; just
  add the call.
- poll the wishlist less often than the library.
- purchases pricing, bookmarks, clips, chapter-level progress (deferred in the
  audiobooks module spec until obtainable reliably).
- notify on finishing a book / starting a new one.
