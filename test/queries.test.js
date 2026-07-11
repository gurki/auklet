import { test, expect, beforeEach } from "bun:test"

import { getDb } from "../src/db/init.js"
import { upsertBook, setMembership, recordSnapshot, setSyncState } from "../src/eventstore.js"
import { recordFinishSession } from "../src/sessions.js"
import { getBooks, getSessions, getStats } from "../src/queries.js"

// Run with: AUKLET_DB_PATH=:memory: bun test
process.env.AUKLET_DB_PATH ||= ":memory:"

beforeEach(() => {
    const db = getDb()
    for (const t of ["events", "progress_snapshots", "sessions", "sync_state", "listening_stats", "books"]) {
        db.exec(`DELETE FROM ${t}`)
    }
})

function book(asin, fields = {}) {
    upsertBook({
        asin,
        title: fields.title ?? asin,
        authors: fields.authors ?? ["Author"],
        durationSec: fields.durationSec ?? 36000,
        percentComplete: fields.percentComplete,
        isFinished: fields.isFinished ?? false,
    })
    if (fields.inLibrary) setMembership(asin, true)
}

function finishWithBackfillOnly(asin, finishedAt = "2026-07-01T10:00:00Z") {
    getDb().prepare("UPDATE books SET finished_at = ?, is_finished = 0 WHERE asin = ?").run(finishedAt, asin)
}

test("raw zero progress is reported as unknown, not not-started", () => {
    book("ZERO", { percentComplete: 0 })

    const row = getBooks().books[0]
    expect(row.progress_status).toBe("unknown")
    expect(row.progress_percent).toBeNull()
    expect(row.progress_label).toBe("unknown")
})

test("positive progress is reported as in progress with a rounded percent", () => {
    book("ACTIVE", { percentComplete: 42.6 })

    const row = getBooks().books[0]
    expect(row.progress_status).toBe("in_progress")
    expect(row.progress_percent).toBe(43)
    expect(row.progress_label).toBe("43%")
})

test("backfilled finishes before tracking are displayed as unknown", () => {
    book("FINISHED", { percentComplete: 0, isFinished: false })
    setSyncState("tracking_started_at", "2026-07-02T00:00:00Z")
    finishWithBackfillOnly("FINISHED", "2026-07-01T10:00:00Z")

    const row = getBooks().books[0]
    expect(row.progress_status).toBe("unknown")
    expect(row.progress_percent).toBeNull()
    expect(row.progress_label).toBe("unknown")
})

test("backfilled finishes after tracking are trusted", () => {
    book("FINISHED", { percentComplete: 0, isFinished: false })
    setSyncState("tracking_started_at", "2026-07-01T00:00:00Z")
    finishWithBackfillOnly("FINISHED", "2026-07-02T10:00:00Z")

    const row = getBooks().books[0]
    expect(row.progress_status).toBe("finished")
    expect(row.progress_percent).toBe(100)
    expect(row.progress_label).toBe("finished")
    expect(getStats().totals.finished).toBe(1)
})

test("baseline finished state is not trusted until a later finish observation", () => {
    book("FINISHED", { percentComplete: 100, isFinished: true })
    setSyncState("tracking_started_at", "2026-07-01T00:00:00Z")
    recordSnapshot({ asin: "FINISHED", observedAt: "2026-07-01T10:00:00Z", percentComplete: 100, positionSec: 36000, isFinished: true })

    expect(getBooks().books[0].progress_status).toBe("unknown")

    recordSnapshot({ asin: "FINISHED", observedAt: "2026-07-01T10:10:00Z", percentComplete: 100, positionSec: 36000, isFinished: false })
    recordSnapshot({ asin: "FINISHED", observedAt: "2026-07-01T10:20:00Z", percentComplete: 100, positionSec: 36000, isFinished: true })

    expect(getBooks().books[0].progress_status).toBe("finished")
})

test("history marks pre-tracking exact finish markers as unknown", () => {
    book("FINISHED", { percentComplete: 0, isFinished: false })
    setSyncState("tracking_started_at", "2026-07-02T00:00:00Z")
    recordFinishSession("FINISHED", "2026-07-01T10:00:00Z", 36000)

    expect(getSessions().sessions[0].confidence).toBe("exact")
    expect(getSessions().sessions[0].display_confidence).toBe("pre_tracking")
})

test("history keeps exact finish markers after tracking trusted", () => {
    book("FINISHED", { percentComplete: 0, isFinished: false })
    setSyncState("tracking_started_at", "2026-07-01T00:00:00Z")
    recordFinishSession("FINISHED", "2026-07-02T10:00:00Z", 36000)

    expect(getSessions().sessions[0].display_confidence).toBe("exact")
})
