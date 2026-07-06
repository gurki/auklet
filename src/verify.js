import { existsSync } from "node:fs"

import { getDb } from "./db/init.js"
import { hasCredentials } from "./auth.js"
import { syncLibrary } from "./sync.js"
import { localMonth } from "./time.js"

// Consistency guarantee: refresh current state from the source of truth (so the
// membership cache matches Audible), then integrity checks over the local
// journal. Report-only. Note that saved history is append-only: local event
// counts can exceed the current library once anything was ever removed.
export async function verify({ strict = false, deep = false } = {}) {
    const db = getDb()
    const checks = []
    const check = (name, ok, detail) => checks.push({ name, ok, detail })

    // 1. refresh from the api (skipped when unauthenticated / offline)
    if (hasCredentials()) {
        try {
            const lib = await syncLibrary()
            const inLibrary = db.prepare("SELECT COUNT(*) n FROM books WHERE in_library = 1").get().n
            check("library membership", inLibrary === lib.total,
                `${inLibrary} books in_library vs ${lib.total} from the audible api`)
        } catch (error) {
            check("api refresh", false, `could not reach audible api: ${error.message}`)
        }
    } else {
        check("api refresh", !strict, "not authenticated - run `auklet login` (skipped api completeness)")
    }

    // 2. orphan events / sessions (reference a book we never stored)
    const orphanEvents = db.prepare(
        "SELECT COUNT(*) n FROM events e LEFT JOIN books b ON b.asin = e.book_asin WHERE b.asin IS NULL"
    ).get().n
    check("orphan events", orphanEvents === 0, `${orphanEvents} events without a book row`)

    const orphanSessions = db.prepare(
        "SELECT COUNT(*) n FROM sessions s LEFT JOIN books b ON b.asin = s.book_asin WHERE b.asin IS NULL"
    ).get().n
    check("orphan sessions", orphanSessions === 0, `${orphanSessions} sessions without a book row`)

    // 3. listen accounting: summed session audio must not exceed observed advance
    const sessionSec = db.prepare("SELECT COALESCE(SUM(listened_sec),0) n FROM sessions").get().n
    const observedSec = db.prepare("SELECT COALESCE(SUM(delta_sec),0) n FROM progress_snapshots").get().n
    check("listen accounting", sessionSec <= observedSec,
        `${sessionSec}s in sessions <= ${observedSec}s observed advance (difference is the open, not-yet-closed session)`)

    // 4. cover coverage + files on disk
    const missingCover = db.prepare(
        "SELECT COUNT(*) n FROM books WHERE in_library = 1 AND cover_url IS NOT NULL AND cover_sha256 IS NULL"
    ).get().n
    check("cover coverage", missingCover === 0, `${missingCover} library books without a stored cover${missingCover ? " - run hydrate" : ""}`)

    const coverRows = db.prepare("SELECT sha256, path FROM covers").all()
    const lost = coverRows.filter((row) => !existsSync(row.path))
    check("cover files", lost.length === 0, `${lost.length} of ${coverRows.length} cover files missing on disk`)

    if (deep) {
        const { createHash } = await import("node:crypto")
        const { readFileSync } = await import("node:fs")
        const corrupt = coverRows.filter((row) =>
            existsSync(row.path) &&
            createHash("sha256").update(readFileSync(row.path)).digest("hex") !== row.sha256)
        check("cover integrity (deep)", corrupt.length === 0, `${corrupt.length} files fail re-hash`)
    }

    // 5. month bucketing invariant
    const badEventMonths = db.prepare("SELECT triggered_at, month FROM events").all()
        .filter((row) => localMonth(row.triggered_at) !== row.month).length
    check("event month bucketing", badEventMonths === 0, `${badEventMonths} events with inconsistent month`)

    const badSessionMonths = db.prepare("SELECT ended_at, month FROM sessions").all()
        .filter((row) => localMonth(row.ended_at) !== row.month).length
    check("session month bucketing", badSessionMonths === 0, `${badSessionMonths} sessions with inconsistent month`)

    return { ok: checks.every((c) => c.ok), checks }
}
