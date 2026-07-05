import { createHash } from "node:crypto"
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { getDb } from "./db/init.js"

const COVER_DIR = process.env.AUKLET_COVER_DIR
    || join(resolve(import.meta.dirname, "../db"), "covers")

// Same layout as the journey blob store: sha256/<aa>/<bb>/<full-hash>, no
// extension - the path is derivable from the hash alone; content type lives in
// the covers table.
export function coverPath(sha256) {
    return join(COVER_DIR, "sha256", sha256.slice(0, 2), sha256.slice(2, 4), sha256)
}

async function storeCover(db, url) {
    const existing = db.prepare("SELECT sha256 FROM covers WHERE source_url = ?").get(url)
    if (existing) return existing.sha256

    const res = await fetch(url)
    if (!res.ok) throw new Error(`cover download failed: ${res.status} ${url}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    const sha256 = createHash("sha256").update(bytes).digest("hex")

    // dedupe by content: the same bytes from a different url reuse the row
    const byHash = db.prepare("SELECT sha256 FROM covers WHERE sha256 = ?").get(sha256)
    if (byHash) return byHash.sha256

    const path = coverPath(sha256)
    if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true })
        const tmp = `${path}.tmp-${process.pid}`
        writeFileSync(tmp, bytes)
        renameSync(tmp, path)
    }

    db.prepare(`
        INSERT OR IGNORE INTO covers (sha256, path, source_url, content_type, bytes)
        VALUES (?, ?, ?, ?, ?)
    `).run(sha256, path, url, res.headers.get("content-type"), bytes.length)

    return sha256
}

// Download cover art into the content-addressed store for books that have a
// cover_url but no stored blob yet. Setting cover_sha256 bumps updated_at so
// the book re-pushes to journey with its artwork attachment. Idempotent.
export async function hydrate({ onProgress = () => {} } = {}) {
    const db = getDb()
    const pending = db.prepare(`
        SELECT asin, cover_url FROM books
        WHERE cover_url IS NOT NULL AND cover_sha256 IS NULL
    `).all()

    if (pending.length === 0) return { hydrated: 0, coversDownloaded: 0, failed: 0 }

    const setCover = db.prepare("UPDATE books SET cover_sha256 = ?, updated_at = datetime('now') WHERE asin = ?")
    const cache = new Map() // url -> sha256 (dedupe within the run)
    let downloaded = 0
    let failed = 0

    for (let i = 0; i < pending.length; i++) {
        const { asin, cover_url } = pending[i]
        try {
            if (!cache.has(cover_url)) {
                cache.set(cover_url, await storeCover(db, cover_url))
                downloaded++
            }
            setCover.run(cache.get(cover_url), asin)
        } catch (error) {
            console.error("❌ cover hydrate failed for", asin, error.message)
            failed++
        }
        onProgress(`${i + 1}/${pending.length} covers`)
    }

    return { hydrated: pending.length - failed, coversDownloaded: downloaded, failed }
}
