import { getDb } from "./db/init.js"
import { getSyncState } from "./eventstore.js"
import { coverPath } from "./hydrate.js"

const TRUSTED_FINISHED_EXPR = `(
    (b.finished_at IS NOT NULL AND b.finished_at > @trustAfter)
    OR EXISTS (
        SELECT 1 FROM progress_snapshots p
        WHERE p.book_asin = b.asin
          AND p.is_finished = 1
          AND p.observed_at > @trustAfter
          AND p.observed_at > (
              SELECT MIN(p0.observed_at) FROM progress_snapshots p0 WHERE p0.book_asin = b.asin
          )
    )
)`

const UNTRUSTED_FINISHED_EXPR = "(b.is_finished = 1 OR b.finished_at IS NOT NULL OR b.percent_complete >= 99.5)"
const NO_TRUST_AFTER = "9999-12-31T23:59:59.999Z"

function getTrustAfter(db = getDb()) {
    return process.env.AUKLET_TRUST_AFTER
        || getSyncState("tracking_started_at")
        || db.prepare("SELECT MIN(observed_at) AS ts FROM progress_snapshots").get()?.ts
        || null
}

function trustParams(db = getDb()) {
    const trustAfter = getTrustAfter(db)
    return { trustAfter: trustAfter ?? NO_TRUST_AFTER, reportedTrustAfter: trustAfter }
}

export function getStats() {
    const db = getDb()
    const trust = trustParams(db)

    const totals = db.prepare(`
        SELECT
            (SELECT COUNT(*) FROM books WHERE in_library = 1) AS library,
            (SELECT COUNT(*) FROM books b WHERE ${TRUSTED_FINISHED_EXPR}) AS finished,
            (SELECT COUNT(*) FROM sessions) AS sessions,
            (SELECT COALESCE(SUM(listened_sec), 0) FROM sessions) AS listenedSec
    `).get(trust)

    const listenedPerMonth = db.prepare(`
        SELECT month, COUNT(*) AS sessions, SUM(listened_sec) AS listenedSec
        FROM sessions GROUP BY month ORDER BY month
    `).all()

    const topAuthors = db.prepare(`
        SELECT je.value AS author, COUNT(*) AS books
        FROM books b, json_each(b.authors) je
        WHERE b.in_library = 1
        GROUP BY je.value ORDER BY books DESC LIMIT 20
    `).all()

    const rows = db.prepare(`
        SELECT CAST(substr(local_time, 12, 2) AS INTEGER) AS hour, COUNT(*) AS n
        FROM sessions WHERE local_time IS NOT NULL GROUP BY hour
    `).all()
    const listensByHour = Array.from({ length: 24 }, (_, h) => rows.find((r) => r.hour === h)?.n ?? 0)

    const lifetimeListenedSec = db.prepare("SELECT COALESCE(SUM(seconds),0) n FROM listening_stats WHERE kind='monthly'").get().n

    return {
        totals: { ...totals, lifetimeListenedSec },
        listenedPerMonth,
        topAuthors,
        listensByHour,
        trust: { trackingStartedAt: trust.reportedTrustAfter },
        lastLibrarySync: getSyncState("last_library_sync"),
        lastJourneySync: getSyncState("last_journey_sync"),
        lastStatsSync: getSyncState("last_stats_sync"),
    }
}

// Historical monthly listening time from Audible's stats (seconds per month).
// This is Audible's own account-wide total (all books/devices), not per-book or
// auklet-observed.
export function getListeningStats() {
    const db = getDb()
    return {
        monthly: db.prepare("SELECT period, seconds FROM listening_stats WHERE kind='monthly' ORDER BY period").all(),
    }
}

// Whitelisted sort orders (interpolated into SQL, so never user text).
const BOOK_ORDER = {
    // author, then each series within that author in reading order; standalones
    // interleave alphabetically by title.
    author: "LOWER(COALESCE(json_extract(b.authors,'$[0]'),'~')) ASC, LOWER(COALESCE(b.series_title, b.title)) ASC, CAST(b.series_position AS REAL) ASC, LOWER(b.title) ASC",
    // by *displayed* progress: finished first, then in-progress (most complete
    // first), then unknown - so finished books group together instead of sorting
    // on their raw percent_complete (which is 0).
    progress: `(CASE WHEN ${TRUSTED_FINISHED_EXPR} THEN 2 WHEN ${UNTRUSTED_FINISHED_EXPR} THEN 0 WHEN b.percent_complete > 0 THEN 1 ELSE 0 END) DESC, b.percent_complete DESC, LOWER(b.title) ASC`,
    // most recently acquired on Audible first (first_seen_at is the same for the
    // whole initial import, so use the library-added event's verbatim Audible date).
    recent: "(SELECT MAX(e.triggered_at) FROM events e WHERE e.book_asin = b.asin AND e.kind = 'library-added') DESC, LOWER(b.title) ASC",
    title: "LOWER(b.title) ASC",
}

export function getBooks({ q = null, list = null, sort = "author", limit = 200, offset = 0 } = {}) {
    const like = q ? `%${q}%` : null
    const membership = list === "library" ? "AND b.in_library = 1" : ""
    const orderBy = BOOK_ORDER[sort] ?? BOOK_ORDER.author
    const trust = trustParams()

    const books = getDb().prepare(`
        SELECT b.asin, b.title, b.subtitle, b.authors, b.narrators, b.series_title, b.series_position,
               b.duration_sec, b.release_date, b.publisher, b.cover_sha256, b.percent_complete,
               b.is_finished, b.finished_at, b.in_library, b.first_seen_at,
               CASE
                   WHEN ${TRUSTED_FINISHED_EXPR} THEN 'finished'
                   WHEN ${UNTRUSTED_FINISHED_EXPR} THEN 'unknown'
                   WHEN b.percent_complete > 0 THEN 'in_progress'
                   ELSE 'unknown'
               END AS progress_status,
               CASE
                   WHEN ${TRUSTED_FINISHED_EXPR} THEN 100
                   WHEN ${UNTRUSTED_FINISHED_EXPR} THEN NULL
                   WHEN b.percent_complete > 0 THEN CAST(ROUND(b.percent_complete) AS INTEGER)
                   ELSE NULL
               END AS progress_percent,
               CASE
                   WHEN ${TRUSTED_FINISHED_EXPR} THEN 'finished'
                   WHEN ${UNTRUSTED_FINISHED_EXPR} THEN 'unknown'
                   WHEN b.percent_complete > 0 THEN CAST(CAST(ROUND(b.percent_complete) AS INTEGER) AS TEXT) || '%'
                   ELSE 'unknown'
               END AS progress_label,
               (SELECT COUNT(*) FROM sessions s WHERE s.book_asin = b.asin) AS listen_sessions,
               (SELECT COALESCE(SUM(listened_sec), 0) FROM sessions s WHERE s.book_asin = b.asin) AS listened_sec
        FROM books b
        WHERE (@like IS NULL OR b.title LIKE @like OR b.authors LIKE @like OR b.series_title LIKE @like)
          ${membership}
        ORDER BY ${orderBy}
        LIMIT @limit OFFSET @offset
    `).all({ ...trust, like, limit: Number(limit) || 200, offset: Number(offset) || 0 })

    return { books, total: books.length, trust: { trackingStartedAt: trust.reportedTrustAfter } }
}

export function getSessions({ month = null, q = null, asin = null, hideUnknown = false, limit = 200, offset = 0 } = {}) {
    const like = q ? `%${q}%` : null
    const trust = trustParams()
    const hideUnknownFlag = ["1", "true", "yes", "on"].includes(String(hideUnknown).toLowerCase()) ? 1 : 0
    const sessions = getDb().prepare(`
        SELECT s.id, s.book_asin, s.started_at, s.ended_at, s.position_start_sec, s.position_end_sec,
               s.listened_sec, s.month, s.local_time, s.finished, s.confidence,
               CASE
                   WHEN s.confidence = 'exact' AND s.ended_at <= @trustAfter THEN 'pre_tracking'
                   ELSE s.confidence
               END AS display_confidence,
               b.title, b.authors, b.cover_sha256, b.duration_sec
        FROM sessions s JOIN books b ON b.asin = s.book_asin
        WHERE (@month IS NULL OR s.month = @month)
          AND (@asin IS NULL OR s.book_asin = @asin)
          AND (@like IS NULL OR b.title LIKE @like OR b.authors LIKE @like)
          AND (@hideUnknown = 0 OR s.confidence != 'exact' OR s.ended_at > @trustAfter)
        ORDER BY s.ended_at DESC
        LIMIT @limit OFFSET @offset
    `).all({ ...trust, month, asin, like, hideUnknown: hideUnknownFlag, limit: Number(limit) || 200, offset: Number(offset) || 0 })

    return { sessions, trust: { trackingStartedAt: trust.reportedTrustAfter } }
}

export function getEvents({ month = null, kind = null, limit = 100, offset = 0 } = {}) {
    const events = getDb().prepare(`
        SELECT e.id, e.kind, e.triggered_at, e.local_time, e.tz, e.month, e.book_asin,
               b.title, b.authors, b.cover_sha256
        FROM events e LEFT JOIN books b ON b.asin = e.book_asin
        WHERE (@kind IS NULL OR e.kind = @kind)
          AND (@month IS NULL OR e.month = @month)
        ORDER BY e.triggered_at DESC
        LIMIT @limit OFFSET @offset
    `).all({ month, kind, limit: Number(limit) || 100, offset: Number(offset) || 0 })

    return { events }
}

export function getSnapshots({ asin, limit = 500 } = {}) {
    const snapshots = getDb().prepare(`
        SELECT observed_at, percent_complete, position_sec, delta_sec, is_finished
        FROM progress_snapshots WHERE book_asin = ? ORDER BY observed_at
        LIMIT ?
    `).all(asin, Number(limit) || 500)
    return { snapshots }
}

export function getCover(sha256) {
    const cover = getDb().prepare("SELECT content_type FROM covers WHERE sha256 = ?").get(sha256)
    return cover ? { ...cover, path: coverPath(sha256) } : null
}
