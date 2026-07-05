import "./src/bugle.js"

import express from "express"
import * as dotenv from "dotenv"
dotenv.config()

import { hasCredentials } from "./src/auth.js"
import { syncLibrary, syncWishlist } from "./src/sync.js"
import { deriveSessions } from "./src/sessions.js"
import { withLock, getJob, verify, journeySync, startHydrate, syncStats } from "./src/ops.js"
import { hydrate } from "./src/hydrate.js"
import { getStats, getBooks, getSessions, getEvents, getSnapshots, getCover, getListeningStats } from "./src/queries.js"
import { BROWSE_HTML } from "./src/browse.js"
import { closeDb } from "./src/db/init.js"

const PORT = Number(process.env.PORT) || 8899
const POLL_INTERVAL_S = Number(process.env.PROGRESS_INTERVAL_S) || 60
const app = express()

// --- health + inspection --------------------------------------------------

app.get("/healthz", (req, res) => res.json({ ok: true, uptime: process.uptime() }))
app.get("/stats", (req, res) => res.json(getStats()))
app.get("/books", (req, res) => res.json(getBooks(req.query)))
app.get("/sessions", (req, res) => res.json(getSessions(req.query)))
app.get("/events", (req, res) => res.json(getEvents(req.query)))
app.get("/snapshots", (req, res) => res.json(getSnapshots(req.query)))
app.get("/listening-stats", (req, res) => res.json(getListeningStats()))

app.get("/cover/:sha256", (req, res) => {
    const cover = getCover(req.params.sha256)
    if (!cover) return res.sendStatus(404)
    res.set("Cache-Control", "public, max-age=31536000, immutable")
    if (cover.content_type) res.type(cover.content_type)
    res.sendFile(cover.path)
})

app.get("/browse", (req, res) => res.type("html").send(BROWSE_HTML))

// --- operations (the daemon is the single executor) -----------------------

const flag = (value) => value === "" || value === "true" || value === "1" || value === true

function opHandler(fn, { autoSync = false } = {}) {
    return async (req, res) => {
        try {
            res.json(await withLock(fn(req)))
            if (autoSync) scheduleSync()
        } catch (error) {
            console.error("❌ op failed:", error)
            res.status(500).json({ error: error.message })
        }
    }
}

app.post("/ops/sync-library", opHandler(() => () => syncLibrary(), { autoSync: true }))
app.post("/ops/sync-wishlist", opHandler(() => () => syncWishlist(), { autoSync: true }))
app.post("/ops/sync-stats", opHandler(() => () => syncStats(), { autoSync: true }))
app.post("/ops/derive-sessions", opHandler((req) => () => deriveSessions({ rebuild: flag(req.query.rebuild) }), { autoSync: true }))
app.post("/ops/verify", opHandler((req) => () => verify({ strict: flag(req.query.strict), deep: flag(req.query.deep) })))
app.post("/ops/journey-sync", opHandler((req) => () => journeySync({ full: flag(req.query.full) })))
app.post("/ops/hydrate", (req, res) => res.status(202).json(startHydrate()))
app.get("/ops/jobs/:id", (req, res) => {
    const job = getJob(req.params.id)
    if (!job) return res.status(404).json({ error: "job not found" })
    res.json(job)
})

// --- downstream sync (debounced) ------------------------------------------

// After a poll, hydrate freshly-discovered covers and push to the journey
// server. Debounced; hydrate always runs (covers also feed /browse), journey
// push only if configured. Failures retry next tick since neither hydrate nor
// the journey cursors advance on error.
let syncTimer = null
const journeyConfigured = () => Boolean(process.env.JOURNEY_TOKEN && process.env.JOURNEY_CLIENT_ID)

function scheduleSync() {
    clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
        withLock(async () => {
            const h = await hydrate()
            if (h.hydrated) console.log(`🎨 hydrated ${h.coversDownloaded} covers for ${h.hydrated} books`)
            if (journeyConfigured()) {
                const j = await journeySync()
                if (j.books || j.listens || j.libraryEvents) {
                    console.log(`🛰️ journey: ${j.books} books, ${j.listens} listens, ${j.libraryEvents} library events`)
                }
            }
        }).catch((error) => console.error("❌ auto-sync failed:", error.message))
    }, 10_000)
}

// --- poll loop -------------------------------------------------------------

// Audible has no incremental feed, so each tick re-fetches the full library +
// wishlist and diffs against local membership (this is also the "rebuild from
// source of truth" path). deriveSessions runs every tick so an open session
// closes once it has gone quiet for SESSION_GAP_S.
async function poll() {
    await withLock(async () => {
        await syncLibrary()
        await syncWishlist()
        deriveSessions()
    })
    scheduleSync()
}

const server = app.listen(PORT, async () => {
    console.log("🐦 auklet listening on", PORT, "...")

    if (!hasCredentials()) {
        console.error("❌ not authenticated - run `auklet login` (or `bun cli.js login`) 👋")
        return
    }

    await poll().catch((error) => console.error("❌ initial poll:", error.message))
    // one-shot historical backfill (finish dates + listening time) on startup
    await withLock(() => syncStats()).catch((error) => console.error("❌ stats backfill:", error.message))
    setInterval(() => poll().catch((error) => console.error("❌ poll:", error.message)), POLL_INTERVAL_S * 1000)
    console.log(`👂 watching audible every ${POLL_INTERVAL_S}s`)
})

function shutdown() {
    console.log("👋 shutting down ...")
    clearTimeout(syncTimer)
    server.close(() => {
        closeDb()
        process.exit(0)
    })
    setTimeout(() => process.exit(1), 5000).unref()
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
