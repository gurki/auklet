import { getDb } from "./db/init.js"
import { localMonth, localTime, TIME_ZONE } from "./time.js"
import { deterministicUlid, changeKey } from "./ids.js"

// Low-level journal writes. Books are the rebuildable current-state cache;
// events (library/wishlist membership changes) and progress_snapshots are the
// append-only history. All inserts are idempotent so restarts and full
// re-syncs never duplicate.

let statements = null

function prepare() {
    if (statements) return statements
    const db = getDb()

    statements = {
        db,

        // metadata + first sighting only; progress and membership are updated
        // separately so a progress poll never bumps updated_at (which would
        // needlessly re-push the book item to journey).
        insertBook: db.prepare(`
            INSERT OR IGNORE INTO books (
                asin, title, subtitle, authors, narrators, series_title, series_position,
                language, duration_sec, release_date, publisher, cover_url,
                percent_complete, is_finished
            ) VALUES (
                @asin, @title, @subtitle, @authors, @narrators, @series_title, @series_position,
                @language, @duration_sec, @release_date, @publisher, @cover_url,
                @percent_complete, @is_finished
            )
        `),

        updateProgress: db.prepare(`
            UPDATE books SET percent_complete = @percent_complete, is_finished = @is_finished
            WHERE asin = @asin
        `),

        setInLibrary: db.prepare("UPDATE books SET in_library = @v WHERE asin = @asin"),

        insertEvent: db.prepare(`
            INSERT OR IGNORE INTO events (
                id, natural_key, kind, book_asin, triggered_at, month, local_time, tz, provider, raw_snapshot
            ) VALUES (
                @id, @natural_key, @kind, @book_asin, @triggered_at, @month, @local_time, @tz, @provider, @raw_snapshot
            )
        `),

        lastSnapshot: db.prepare(`
            SELECT position_sec, is_finished FROM progress_snapshots
            WHERE book_asin = ? ORDER BY observed_at DESC, id DESC LIMIT 1
        `),

        insertSnapshot: db.prepare(`
            INSERT INTO progress_snapshots (book_asin, observed_at, percent_complete, position_sec, delta_sec, is_finished)
            VALUES (@book_asin, @observed_at, @percent_complete, @position_sec, @delta_sec, @is_finished)
        `),

        upsertStat: db.prepare(`
            INSERT INTO listening_stats (kind, period, seconds, updated_at)
            VALUES (@kind, @period, @seconds, datetime('now'))
            ON CONFLICT(kind, period) DO UPDATE SET seconds = excluded.seconds, updated_at = excluded.updated_at
        `),

        setFinished: db.prepare("UPDATE books SET finished_at = @finished_at, is_finished = 1 WHERE asin = @asin"),
    }

    return statements
}

// Upsert stable metadata (idempotent) and refresh the live progress fields.
export function upsertBook(item) {
    const stmts = prepare()
    stmts.insertBook.run({
        asin: item.asin,
        title: item.title ?? null,
        subtitle: item.subtitle ?? null,
        authors: JSON.stringify(item.authors ?? []),
        narrators: JSON.stringify(item.narrators ?? []),
        series_title: item.seriesTitle ?? null,
        series_position: item.seriesPosition ?? null,
        language: item.language ?? null,
        duration_sec: item.durationSec ?? null,
        release_date: item.releaseDate ?? null,
        publisher: item.publisher ?? null,
        cover_url: item.coverUrl ?? null,
        percent_complete: item.percentComplete ?? null,
        is_finished: item.isFinished ? 1 : 0,
    })
    stmts.updateProgress.run({
        asin: item.asin,
        percent_complete: item.percentComplete ?? null,
        is_finished: item.isFinished ? 1 : 0,
    })
    return item.asin
}

export function setMembership(asin, inLibrary) {
    prepare().setInLibrary.run({ asin, v: inLibrary ? 1 : 0 })
}

// Current in-library set, for diffing against a fresh poll.
export function getMembership() {
    return new Set(
        prepare().db.prepare("SELECT asin FROM books WHERE in_library = 1").all().map((r) => r.asin)
    )
}

// A discrete membership change (library/wishlist add/remove). triggered_at is
// verbatim (Audible's date for adds, poll time for removes) and forms the id.
export function recordChange({ kind, ts, asin, raw = null }) {
    const stmts = prepare()
    const naturalKey = changeKey(kind, ts, asin)
    const result = stmts.insertEvent.run({
        id: deterministicUlid(ts, naturalKey),
        natural_key: naturalKey,
        kind,
        book_asin: asin,
        triggered_at: ts,
        month: localMonth(ts),
        local_time: localTime(ts),
        tz: TIME_ZONE,
        provider: "audible",
        raw_snapshot: raw ? JSON.stringify(raw) : null,
    })
    return { inserted: result.changes > 0 }
}

// Append a progress observation, deduped: only recorded when position or
// finished-state changed since the last snapshot. delta_sec is the audio
// advance this snapshot represents (0 on the first sighting of a book, so a
// book's pre-existing progress is never counted as a listen).
export function recordSnapshot({ asin, observedAt, percentComplete = null, positionSec = null, isFinished = false }) {
    const stmts = prepare()
    if (positionSec == null && percentComplete == null) return { inserted: false }

    const prev = stmts.lastSnapshot.get(asin)
    const finished = isFinished ? 1 : 0
    if (prev && prev.position_sec === positionSec && Boolean(prev.is_finished) === Boolean(finished)) {
        return { inserted: false }
    }

    const delta = prev != null && positionSec != null && prev.position_sec != null
        ? Math.max(0, positionSec - prev.position_sec)
        : 0

    stmts.insertSnapshot.run({
        book_asin: asin,
        observed_at: observedAt,
        percent_complete: percentComplete,
        position_sec: positionSec,
        delta_sec: delta,
        is_finished: finished,
    })
    return { inserted: true }
}

export function getSyncState(key) {
    return prepare().db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key)?.value ?? null
}

export function setSyncState(key, value) {
    prepare().db.prepare(`
        INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, String(value))
}

export function setSyncStateOnce(key, value) {
    prepare().db.prepare(`
        INSERT OR IGNORE INTO sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
    `).run(key, String(value))
}

// --- historical backfill (Audible stats endpoints) --------------------------

export function upsertListeningStat(kind, period, seconds) {
    prepare().upsertStat.run({ kind, period, seconds })
}

export function setBookFinished(asin, finishedAt) {
    prepare().setFinished.run({ asin, finished_at: finishedAt })
}
