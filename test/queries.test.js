import { test, expect, beforeEach } from "bun:test"

import { getDb } from "../src/db/init.js"
import { upsertBook, setMembership } from "../src/eventstore.js"
import { getBooks, getStats } from "../src/queries.js"

// Run with: AUKLET_DB_PATH=:memory: bun test

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
    if (fields.inLibrary) setMembership(asin, { inLibrary: true })
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

test("finished_at is authoritative even when raw audible progress is zero", () => {
    book("FINISHED", { percentComplete: 0, isFinished: false })
    finishWithBackfillOnly("FINISHED")

    const row = getBooks().books[0]
    expect(row.progress_status).toBe("finished")
    expect(row.progress_percent).toBe(100)
    expect(row.progress_label).toBe("finished")
})

test("stats count books with only finished_at as finished", () => {
    book("FINISHED", { percentComplete: 0, isFinished: false })
    finishWithBackfillOnly("FINISHED")

    expect(getStats().totals.finished).toBe(1)
})

test("stalled filter excludes books finished by stats backfill", () => {
    book("DONE", { title: "Done", percentComplete: 50, inLibrary: true })
    finishWithBackfillOnly("DONE")
    book("STALLED", { title: "Stalled", percentComplete: 50, inLibrary: true })

    const rows = getBooks({ stalled: true }).books
    expect(rows.map((row) => row.asin)).toEqual(["STALLED"])
    expect(getStats().totals.stalled).toBe(1)
})
