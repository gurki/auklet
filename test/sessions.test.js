import { test, expect, beforeEach } from "bun:test"

import { getDb } from "../src/db/init.js"
import { upsertBook, recordSnapshot } from "../src/eventstore.js"
import { deriveSessions } from "../src/sessions.js"

// Run with: AUKLET_DB_PATH=:memory: bun test
process.env.AUKLET_DB_PATH ||= ":memory:"

const asin = "TESTBOOK1"

beforeEach(() => {
    const db = getDb()
    for (const t of ["events", "progress_snapshots", "sessions", "sync_state", "books"]) db.exec(`DELETE FROM ${t}`)
})

const snap = (observedAt, positionSec, isFinished = false) =>
    recordSnapshot({ asin, observedAt, positionSec, isFinished })

test("infers two sessions split by a gap; pre-existing progress is not counted", () => {
    upsertBook({ asin, title: "Book", authors: ["Author"], durationSec: 36000, percentComplete: 10, isFinished: false })

    // starts already at 3600s (10%) -> baseline, delta 0 (not a listen)
    expect(snap("2026-07-01T10:00:00Z", 3600).inserted).toBe(true)
    expect(snap("2026-07-01T10:01:00Z", 3660).inserted).toBe(true) // +60
    expect(snap("2026-07-01T10:02:00Z", 3720).inserted).toBe(true) // +60
    expect(snap("2026-07-01T10:30:00Z", 3720).inserted).toBe(false) // no change -> deduped
    expect(snap("2026-07-01T11:00:00Z", 3780).inserted).toBe(true) // +60 after a 58min gap
    expect(snap("2026-07-01T11:01:00Z", 3900).inserted).toBe(true) // +120

    const { created } = deriveSessions({ now: "2026-07-01T11:10:00Z" })
    expect(created).toBe(2)

    const rows = getDb().prepare("SELECT * FROM sessions ORDER BY started_at").all()
    expect(rows[0].listened_sec).toBe(120)
    expect(rows[0].position_start_sec).toBe(3600)
    expect(rows[0].position_end_sec).toBe(3720)
    expect(rows[0].started_at).toBe("2026-07-01T10:00:00Z")
    expect(rows[0].ended_at).toBe("2026-07-01T10:02:00Z")

    expect(rows[1].listened_sec).toBe(180)
    expect(rows[1].position_start_sec).toBe(3720)
    expect(rows[1].position_end_sec).toBe(3900)

    // invariant: session audio == total observed advance
    const total = rows.reduce((s, r) => s + r.listened_sec, 0)
    const observed = getDb().prepare("SELECT COALESCE(SUM(delta_sec),0) n FROM progress_snapshots").get().n
    expect(total).toBe(300)
    expect(total).toBe(observed)
})

test("an open (recently active) session is not emitted until it goes quiet", () => {
    upsertBook({ asin, title: "Book", authors: ["Author"], durationSec: 36000 })
    snap("2026-07-01T10:00:00Z", 3600)
    snap("2026-07-01T10:01:00Z", 3660)
    snap("2026-07-01T10:02:00Z", 3720)

    // only 2 min since the last snapshot -> still open, not emitted
    expect(deriveSessions({ now: "2026-07-01T10:04:00Z" }).created).toBe(0)
    // 6 min quiet -> session closes and is emitted
    expect(deriveSessions({ now: "2026-07-01T10:08:00Z" }).created).toBe(1)
})

test("a finished book closes the session immediately", () => {
    upsertBook({ asin, title: "Book", authors: ["Author"], durationSec: 36000 })
    snap("2026-07-01T10:00:00Z", 35000)
    snap("2026-07-01T10:01:00Z", 36000, true) // finished

    // finished, so emitted even though the last snapshot is 1 min ago
    expect(deriveSessions({ now: "2026-07-01T10:02:00Z" }).created).toBe(1)
    const row = getDb().prepare("SELECT * FROM sessions").get()
    expect(row.finished).toBe(1)
})

test("derive is idempotent (re-running creates nothing new)", () => {
    upsertBook({ asin, title: "Book", authors: ["Author"], durationSec: 36000 })
    snap("2026-07-01T10:00:00Z", 3600)
    snap("2026-07-01T10:01:00Z", 3660)
    deriveSessions({ now: "2026-07-01T10:10:00Z" })
    expect(deriveSessions({ now: "2026-07-01T10:10:00Z" }).created).toBe(0)
})
