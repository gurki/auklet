import { getDb } from "./db/init.js"
import { getSyncState, setSyncState } from "./eventstore.js"
import { localMonth, localTime, TIME_ZONE } from "./time.js"
import { deterministicUlid, listenKey } from "./ids.js"

// Derive listen sessions from progress snapshots. A session is a maximal run of
// a book's snapshots with consecutive gaps <= SESSION_GAP_S. Within a run:
//
//   listenedSec  = sum of delta_sec (audio actually observed advancing)
//   positionEnd  = last snapshot's position
//   positionStart= positionEnd - listenedSec
//   startedAt/endedAt = first/last snapshot's observed_at
//
// The invariant: every snapshot's delta is counted in exactly one session, so
// total listenedSec across sessions == total observed audio advance (no loss,
// no double-count). The trailing (open) run is only emitted once it has closed
// - a gap of SESSION_GAP_S has elapsed since its last snapshot, or the book
// finished - so an in-progress session is never emitted with a moving endedAt.
//
// Sessions are pure derived state: `rebuild` recomputes them from scratch, so
// the inference can be improved at any time without losing data.

const GAP_MS = () => (Number(process.env.SESSION_GAP_S) || 300) * 1000

export function deriveSessions({ rebuild = false, now = null } = {}) {
    const db = getDb()
    const gap = GAP_MS()
    const nowIso = now ?? new Date().toISOString()
    const nowMs = Date.parse(nowIso)

    if (rebuild) {
        db.exec("DELETE FROM sessions")
        setSyncState("journey_cursor_sessions", 0)
    }

    const insert = db.prepare(`
        INSERT OR IGNORE INTO sessions (
            id, natural_key, book_asin, started_at, ended_at,
            position_start_sec, position_end_sec, listened_sec,
            month, local_time, tz, finished, confidence
        ) VALUES (
            @id, @natural_key, @book_asin, @started_at, @ended_at,
            @position_start_sec, @position_end_sec, @listened_sec,
            @month, @local_time, @tz, @finished, 'inferred'
        )
    `)

    const books = db.prepare("SELECT DISTINCT book_asin FROM progress_snapshots").all().map((r) => r.book_asin)
    let created = 0

    db.transaction(() => {
        for (const asin of books) {
            const snaps = db.prepare(`
                SELECT observed_at, position_sec, delta_sec, is_finished
                FROM progress_snapshots WHERE book_asin = ? ORDER BY observed_at, id
            `).all(asin)

            let run = []
            const flush = (trailing) => {
                if (run.length === 0) return
                const last = run[run.length - 1]
                // an open (trailing) run is only a finished session once it has
                // gone quiet for a full gap, or the book was marked finished.
                if (trailing && !last.is_finished && nowMs - Date.parse(last.observed_at) < gap) {
                    run = []
                    return
                }
                const listened = run.reduce((sum, s) => sum + (s.delta_sec || 0), 0)
                if (listened > 0) {
                    const endedAt = last.observed_at
                    const positionEnd = last.position_sec ?? listened
                    const positionStart = Math.max(0, positionEnd - listened)
                    const nk = listenKey(endedAt, asin)
                    const res = insert.run({
                        id: deterministicUlid(endedAt, nk),
                        natural_key: nk,
                        book_asin: asin,
                        started_at: run[0].observed_at,
                        ended_at: endedAt,
                        position_start_sec: positionStart,
                        position_end_sec: positionEnd,
                        listened_sec: listened,
                        month: localMonth(endedAt),
                        local_time: localTime(endedAt),
                        tz: TIME_ZONE,
                        finished: last.is_finished ? 1 : 0,
                    })
                    created += res.changes
                }
                run = []
            }

            for (const snap of snaps) {
                if (run.length > 0) {
                    const prev = run[run.length - 1]
                    if (Date.parse(snap.observed_at) - Date.parse(prev.observed_at) > gap) flush(false)
                }
                run.push(snap)
            }
            flush(true)
        }
    })()

    return { created }
}
