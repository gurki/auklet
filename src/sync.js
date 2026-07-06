import { getDb } from "./db/init.js"
import { fetchLibrary, fetchFinished, fetchListeningStats } from "./provider/audible.js"
import {
    upsertBook, setMembership, getMembership, recordChange, recordSnapshot, setSyncState,
    upsertListeningStat, setBookFinished,
} from "./eventstore.js"
import { recordFinishSession } from "./sessions.js"

// Fetch the full library from Audible (the source of truth) and diff it against
// the local in-library set. This is BOTH the periodic poll and the manual
// "rebuild current state" op - same code, so current state is always
// reconstructable from the API. Only change *history* (library add/remove
// events, progress snapshots) is capture-dependent.
//
// On the very first sync the local set is empty, so every owned book emits a
// library-added event stamped with Audible's own purchase/added date (a real
// historical backfill); nothing is ever reported as removed spuriously.
export async function syncLibrary() {
    const db = getDb()
    const now = new Date().toISOString()
    const items = await fetchLibrary()
    const prev = getMembership()
    const seen = new Set()

    let added = 0, removed = 0, snapshots = 0
    db.transaction(() => {
        for (const item of items) {
            if (!item.asin) continue
            seen.add(item.asin)
            upsertBook(item)
            setMembership(item.asin, true)

            if (!prev.has(item.asin)) {
                const ts = item.addedAt || now
                if (recordChange({ kind: "library-added", ts, asin: item.asin }).inserted) added++
            }

            if (item.positionSec != null || item.percentComplete != null) {
                if (recordSnapshot({
                    asin: item.asin,
                    observedAt: now,
                    percentComplete: item.percentComplete,
                    positionSec: item.positionSec,
                    isFinished: item.isFinished,
                }).inserted) snapshots++
            }
        }

        for (const asin of prev) {
            if (seen.has(asin)) continue
            setMembership(asin, false)
            if (recordChange({ kind: "library-removed", ts: now, asin }).inserted) removed++
        }
    })()

    setSyncState("last_library_sync", now)
    console.log(`📚 library: ${items.length} books · +${added} -${removed} · ${snapshots} progress snapshots`)
    return { total: items.length, added, removed, snapshots }
}

// Backfill *history* from Audible's stats endpoints: per-month total listening
// time (years of it) and per-book finish dates (back-dated as exact finish
// markers). Finish markers only apply to books currently in the library;
// aggregate listening time is kept locally (it isn't per-book, so it doesn't map
// to an audiobook.listen item). Idempotent - upserts and INSERT OR IGNORE.
export async function syncStats() {
    const finished = await fetchFinished()
    const { monthly } = await fetchListeningStats()
    const db = getDb()
    const durationByAsin = new Map(
        db.prepare("SELECT asin, duration_sec FROM books").all().map((r) => [r.asin, r.duration_sec])
    )

    let markedFinished = 0, finishMarkers = 0
    db.transaction(() => {
        for (const [period, seconds] of monthly) upsertListeningStat("monthly", period, seconds)
        for (const [asin, finishedAt] of finished) {
            if (!durationByAsin.has(asin)) continue // finished title no longer/not in the library
            setBookFinished(asin, finishedAt)
            markedFinished++
            if (recordFinishSession(asin, finishedAt, durationByAsin.get(asin))) finishMarkers++
        }
    })()

    setSyncState("last_stats_sync", new Date().toISOString())
    console.log(`📈 stats: ${monthly.size} months · ${markedFinished} finished books (${finishMarkers} new markers)`)
    return { months: monthly.size, finishedBooks: markedFinished, finishMarkers }
}
