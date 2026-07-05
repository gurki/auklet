import { readFileSync } from "node:fs"

import { getDb } from "./db/init.js"
import { getSyncState, setSyncState } from "./eventstore.js"
import { entityUlid, bookKey } from "./ids.js"

// Push auklet's canonical data to a journey server as audiobook.* items over
// the normal sync api. Item ids are deterministic (book ids derive from the
// asin; listen/event ids are journey ulids already), so pushes are idempotent
// and re-runnable - the server absorbs duplicates.

const JOURNEY_URL = () => process.env.JOURNEY_URL || "http://127.0.0.1:8090"
const CLIENT_VERSION = "0.1.0"

function config() {
    const token = process.env.JOURNEY_TOKEN
    const clientId = process.env.JOURNEY_CLIENT_ID
    if (!token || !clientId) throw new Error("JOURNEY_TOKEN and JOURNEY_CLIENT_ID must be set")
    return { url: JOURNEY_URL(), token, clientId }
}

// db datetime('now') is "YYYY-MM-DD HH:MM:SS" (UTC); observed timestamps are
// already ISO. Normalize both to ISO-with-Z.
const toIso = (s) => (s == null ? s : s.includes("T") ? s : s.replace(" ", "T") + "Z")

function source(clientId) {
    return { clientId, client: "auklet", clientVersion: CLIENT_VERSION, provider: "audible" }
}

export const bookItemId = (asin) => entityUlid(bookKey(asin))

// --- item builders ---------------------------------------------------------

function bookItem(row, cover, clientId) {
    const created = toIso(row.first_seen_at)
    const item = {
        id: bookItemId(row.asin),
        type: "audiobook.book",
        schemaVersion: "1",
        ts: created,
        createdAt: created,
        updatedAt: toIso(row.updated_at ?? row.first_seen_at),
        source: source(clientId),
        data: {
            title: row.title,
            authors: JSON.parse(row.authors ?? "[]"),
            ...(row.narrators && { narrators: JSON.parse(row.narrators) }),
            ...(row.series_title && {
                series: { title: row.series_title, ...(row.series_position && { position: row.series_position }) },
            }),
            ...(row.language && { language: row.language }),
            ...(row.duration_sec != null && { durationSec: row.duration_sec }),
            ...(row.release_date && { releaseDate: row.release_date }),
            ...(row.publisher && { publisher: row.publisher }),
            providerIds: { audible: row.asin },
            ...(row.cover_url && { cover: { url: row.cover_url } }),
        },
    }
    if (cover) {
        item.attachments = [{
            id: `sha256:${cover.sha256}`,
            mime: cover.content_type ?? "image/jpeg",
            size: cover.bytes,
            role: "artwork",
        }]
    }
    return item
}

function bookRef(book) {
    return { title: book.title, authors: JSON.parse(book.authors ?? "[]"), providerId: book.asin }
}

function sessionItem(row, clientId) {
    const ts = toIso(row.ended_at)
    return {
        id: row.id,
        type: "audiobook.listen",
        schemaVersion: "1",
        ts,
        createdAt: ts,
        updatedAt: ts,
        ...(row.tz && { tz: row.tz }),
        source: source(clientId),
        data: {
            provider: "audible",
            book: { itemId: bookItemId(row.book_asin), ...bookRef({ title: row.title, authors: row.authors, asin: row.book_asin }) },
            startedAt: toIso(row.started_at),
            endedAt: ts,
            ...(row.position_start_sec != null && { positionStartSec: row.position_start_sec }),
            ...(row.position_end_sec != null && { positionEndSec: row.position_end_sec }),
            ...(row.listened_sec != null && { listenedSec: row.listened_sec }),
            source: "progress-poll",
            confidence: row.confidence ?? "inferred",
            ...(row.finished && { finished: true }),
        },
    }
}

function libraryEventItem(event, book, clientId) {
    const ts = toIso(event.triggered_at)
    return {
        id: event.id,
        type: "audiobook.library_event",
        schemaVersion: "1",
        ts,
        createdAt: ts,
        updatedAt: ts,
        ...(event.tz && { tz: event.tz }),
        source: source(clientId),
        data: {
            event: event.kind,
            provider: "audible",
            book: bookRef({ title: book.title, authors: book.authors, asin: event.book_asin }),
        },
    }
}

// --- transport --------------------------------------------------------------

async function api(cfg, method, path, body, headers = {}) {
    return fetch(cfg.url + path, {
        method,
        headers: { "Authorization": `Bearer ${cfg.token}`, ...headers },
        body,
    })
}

async function pushItems(cfg, items, result) {
    for (let i = 0; i < items.length; i += 200) {
        const batch = items.slice(i, i + 200)
        const res = await api(cfg, "POST", "/api/sync",
            JSON.stringify({ since: 0, limit: 0, push: batch }),
            { "Content-Type": "application/json" })
        if (!res.ok) throw new Error(`journey sync failed: ${res.status} ${await res.text()}`)
        const body = await res.json()
        result.accepted += body.accepted?.length ?? 0
        result.superseded += body.superseded?.length ?? 0
        for (const rejection of body.rejected ?? []) {
            result.rejected.push(rejection)
            console.error("❌ journey rejected", rejection.id ?? "", rejection.reason ?? "")
        }
    }
}

async function uploadBlob(cfg, cover, result) {
    const head = await api(cfg, "HEAD", `/api/blobs/sha256:${cover.sha256}`)
    if (head.status === 200) { result.blobsSkipped++; return }

    const bytes = readFileSync(cover.path)
    const res = await api(cfg, "PUT", `/api/blobs/sha256:${cover.sha256}`, bytes, {
        "Content-Type": cover.content_type ?? "application/octet-stream",
    })
    if (!res.ok) throw new Error(`blob upload failed: ${res.status} sha256:${cover.sha256}`)
    result.blobsUploaded++
}

// --- sync op ----------------------------------------------------------------

export async function journeySync({ full = false } = {}) {
    const cfg = config()
    const db = getDb()
    const result = { books: 0, listens: 0, libraryEvents: 0, blobsUploaded: 0, blobsSkipped: 0, accepted: 0, superseded: 0, rejected: [] }

    // 1. books (with cover blobs first - the server requires attachment blobs
    //    to exist before the referencing item). Dirty-driven: books never
    //    synced or updated since (metadata backfill / cover hydrate). --full
    //    re-pushes every book with a title.
    const dirty = full ? "" : "AND (b.journey_synced_at IS NULL OR b.journey_synced_at < b.updated_at)"
    const bookRows = db.prepare(`
        SELECT b.*, c.sha256, c.path, c.content_type, c.bytes
        FROM books b LEFT JOIN covers c ON c.sha256 = b.cover_sha256
        WHERE b.title IS NOT NULL ${dirty}
        ORDER BY b.rowid
    `).all()

    const bookItems = []
    const pushedAsins = []
    for (const row of bookRows) {
        if (row.sha256) await uploadBlob(cfg, row, result)
        bookItems.push(bookItem(row, row.sha256 ? row : null, cfg.clientId))
        pushedAsins.push(row.asin)
    }
    await pushItems(cfg, bookItems, result)
    result.books = bookItems.length

    const bookOf = new Map()
    const lookupBook = (asin) => {
        if (!bookOf.has(asin)) bookOf.set(asin, db.prepare("SELECT asin, title, authors FROM books WHERE asin = ?").get(asin))
        return bookOf.get(asin)
    }

    // 2. library/wishlist events -> audiobook.library_event (rowid cursor)
    const eventCursor = full ? 0 : Number(getSyncState("journey_cursor_events")) || 0
    const eventRows = db.prepare("SELECT rowid AS rid, * FROM events WHERE rowid > ? ORDER BY rowid").all(eventCursor)
    const eventItems = []
    for (const event of eventRows) {
        const book = lookupBook(event.book_asin)
        if (!book?.title) continue
        eventItems.push(libraryEventItem(event, book, cfg.clientId))
    }
    await pushItems(cfg, eventItems, result)
    result.libraryEvents = eventItems.length

    // 3. listen sessions -> audiobook.listen (rowid cursor)
    const sessionCursor = full ? 0 : Number(getSyncState("journey_cursor_sessions")) || 0
    const sessionRows = db.prepare(`
        SELECT s.rowid AS rid, s.*, b.title, b.authors
        FROM sessions s JOIN books b ON b.asin = s.book_asin
        WHERE s.rowid > ? ORDER BY s.rowid
    `).all(sessionCursor)
    const sessionItems = sessionRows.map((row) => sessionItem(row, cfg.clientId))
    await pushItems(cfg, sessionItems, result)
    result.listens = sessionItems.length

    if (result.rejected.length === 0) {
        const markSynced = db.prepare("UPDATE books SET journey_synced_at = datetime('now') WHERE asin = ?")
        db.transaction(() => { for (const asin of pushedAsins) markSynced.run(asin) })()
        if (eventRows.length) setSyncState("journey_cursor_events", eventRows[eventRows.length - 1].rid)
        if (sessionRows.length) setSyncState("journey_cursor_sessions", sessionRows[sessionRows.length - 1].rid)
        setSyncState("last_journey_sync", new Date().toISOString())
    }

    return result
}
