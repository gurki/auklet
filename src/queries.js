import { getDb } from "./db/init.js"
import { getSyncState } from "./eventstore.js"

// Part-of-day bands over the local hour (night wraps midnight).
const PART_HOURS = {
    morning: [5, 11],
    afternoon: [12, 16],
    evening: [17, 21],
    night: [22, 4],
}

const FINISHED_EXPR = "(b.is_finished = 1 OR b.finished_at IS NOT NULL)"

function partClause(part, column = "s.local_time") {
    const band = PART_HOURS[part]
    if (!band) return null
    const [from, to] = band
    const hour = `CAST(substr(${column}, 12, 2) AS INTEGER)`
    return from <= to ? `${hour} BETWEEN ${from} AND ${to}` : `(${hour} >= ${from} OR ${hour} <= ${to})`
}

export function getStats() {
    const db = getDb()

    const totals = db.prepare(`
        SELECT
            (SELECT COUNT(*) FROM books) AS books,
            (SELECT COUNT(*) FROM books WHERE in_library = 1) AS library,
            (SELECT COUNT(*) FROM books WHERE on_wishlist = 1) AS wishlist,
            (SELECT COUNT(*) FROM books b WHERE ${FINISHED_EXPR}) AS finished,
            (SELECT COUNT(*) FROM sessions) AS sessions,
            (SELECT COALESCE(SUM(listened_sec), 0) FROM sessions) AS listenedSec,
            (SELECT COUNT(*) FROM books b WHERE in_library = 1 AND NOT ${FINISHED_EXPR}
                AND percent_complete >= 40 AND percent_complete <= 80) AS stalled
    `).get()

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
        lastLibrarySync: getSyncState("last_library_sync"),
        lastWishlistSync: getSyncState("last_wishlist_sync"),
        lastJourneySync: getSyncState("last_journey_sync"),
        lastStatsSync: getSyncState("last_stats_sync"),
    }
}

// Historical listening time from Audible's stats aggregates (seconds per period).
export function getListeningStats() {
    const db = getDb()
    return {
        monthly: db.prepare("SELECT period, seconds FROM listening_stats WHERE kind='monthly' ORDER BY period").all(),
        daily: db.prepare("SELECT period, seconds FROM listening_stats WHERE kind='daily' ORDER BY period").all(),
    }
}

// Whitelisted sort orders (interpolated into SQL, so never user text).
// "author" keeps an author's books together and, within them, groups each
// series in reading order; standalones interleave alphabetically by title.
const BOOK_ORDER = {
    author: "LOWER(COALESCE(json_extract(b.authors,'$[0]'),'~')) ASC, LOWER(COALESCE(b.series_title, b.title)) ASC, CAST(b.series_position AS REAL) ASC, LOWER(b.title) ASC",
    series: "CASE WHEN b.series_title IS NULL THEN 1 ELSE 0 END ASC, LOWER(COALESCE(b.series_title, b.title)) ASC, CAST(b.series_position AS REAL) ASC, LOWER(b.title) ASC",
    progress: "b.percent_complete DESC NULLS LAST, LOWER(b.title) ASC",
    title: "LOWER(b.title) ASC",
    recent: "b.first_seen_at DESC, LOWER(b.title) ASC",
}

export function getBooks({ q = null, list = null, stalled = false, sort = "author", limit = 200, offset = 0 } = {}) {
    const like = q ? `%${q}%` : null
    const membership = list === "wishlist" ? "AND b.on_wishlist = 1"
        : list === "library" ? "AND b.in_library = 1" : ""
    const stalledClause = stalled ? `AND NOT ${FINISHED_EXPR} AND b.percent_complete >= 40 AND b.percent_complete <= 80` : ""
    const orderBy = BOOK_ORDER[sort] ?? BOOK_ORDER.author

    const books = getDb().prepare(`
        SELECT b.asin, b.title, b.subtitle, b.authors, b.narrators, b.series_title, b.series_position,
               b.duration_sec, b.release_date, b.publisher, b.cover_sha256, b.percent_complete,
               b.is_finished, b.finished_at, b.in_library, b.on_wishlist, b.first_seen_at,
               CASE
                   WHEN ${FINISHED_EXPR} THEN 'finished'
                   WHEN b.percent_complete > 0 THEN 'in_progress'
                   ELSE 'unknown'
               END AS progress_status,
               CASE
                   WHEN ${FINISHED_EXPR} THEN 100
                   WHEN b.percent_complete > 0 THEN CAST(ROUND(b.percent_complete) AS INTEGER)
                   ELSE NULL
               END AS progress_percent,
               CASE
                   WHEN ${FINISHED_EXPR} THEN 'finished'
                   WHEN b.percent_complete > 0 THEN CAST(CAST(ROUND(b.percent_complete) AS INTEGER) AS TEXT) || '%'
                   ELSE 'unknown'
               END AS progress_label,
               (SELECT COUNT(*) FROM sessions s WHERE s.book_asin = b.asin) AS listen_sessions,
               (SELECT COALESCE(SUM(listened_sec), 0) FROM sessions s WHERE s.book_asin = b.asin) AS listened_sec
        FROM books b
        WHERE (@like IS NULL OR b.title LIKE @like OR b.authors LIKE @like OR b.series_title LIKE @like)
          ${membership} ${stalledClause}
        ORDER BY ${orderBy}
        LIMIT @limit OFFSET @offset
    `).all({ like, limit: Number(limit) || 200, offset: Number(offset) || 0 })

    return { books, total: books.length }
}

export function getSessions({ month = null, part = null, q = null, asin = null, limit = 200, offset = 0 } = {}) {
    const part_sql = part ? partClause(part) : null
    const like = q ? `%${q}%` : null
    const sessions = getDb().prepare(`
        SELECT s.id, s.book_asin, s.started_at, s.ended_at, s.position_start_sec, s.position_end_sec,
               s.listened_sec, s.month, s.local_time, s.finished, s.confidence,
               b.title, b.authors, b.cover_sha256, b.duration_sec
        FROM sessions s JOIN books b ON b.asin = s.book_asin
        WHERE (@month IS NULL OR s.month = @month)
          AND (@asin IS NULL OR s.book_asin = @asin)
          AND (@like IS NULL OR b.title LIKE @like OR b.authors LIKE @like)
          ${part_sql ? `AND ${part_sql}` : ""}
        ORDER BY s.ended_at DESC
        LIMIT @limit OFFSET @offset
    `).all({ month, asin, like, limit: Number(limit) || 200, offset: Number(offset) || 0 })

    return { sessions }
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
    return getDb().prepare("SELECT path, content_type FROM covers WHERE sha256 = ?").get(sha256) ?? null
}
