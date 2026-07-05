# notes

## known limitations

- **live-capture only.** auklet can rebuild *current* state from the api anytime,
  but change *history* (adds/removes/progress) only accrues while it's running.
  anything that happened while it was off is invisible — except `library-added`,
  which the first sync backfills from Audible's own purchase/added dates.

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

- **exact last position.** `POST /1.0/content/{asin}/licenserequest` with the
  `last_position_heard` response group would give the precise position (ms)
  instead of the percent-derived estimate. audible-api-ts signs requests but does
  not expose this endpoint yet — would need a low-level request helper or an
  upstream PR.
- poll the wishlist less often than the library.
- purchases pricing, bookmarks, clips, chapter-level progress (deferred in the
  audiobooks module spec until obtainable reliably).
- notify on finishing a book / starting a new one.
