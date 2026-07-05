import { getDb } from "./db/init.js"
import { fetchLibrary, fetchWishlist } from "./provider/audible.js"
import {
    upsertBook, setMembership, getMembership, recordChange, recordSnapshot, setSyncState,
} from "./eventstore.js"

// Fetch the full library/wishlist from Audible (the source of truth) and diff
// it against the local membership set. This is BOTH the periodic poll and the
// manual "rebuild current state" op - same code, so current state is always
// reconstructable from the API. Only change *history* (add/remove events,
// progress snapshots) is capture-dependent.
//
// On the very first sync the local set is empty, so every owned book emits a
// library-added event stamped with Audible's own purchase/added date (a real
// historical backfill); nothing is ever reported as removed spuriously.

async function syncList({ list, fetch, addedKind, removedKind, snapshot }) {
    const db = getDb()
    const now = new Date().toISOString()
    const items = await fetch()
    const prev = getMembership(list)
    const seen = new Set()

    let added = 0, removed = 0, snapshots = 0
    db.transaction(() => {
        for (const item of items) {
            if (!item.asin) continue
            seen.add(item.asin)
            upsertBook(item)
            setMembership(item.asin, list === "wishlist" ? { onWishlist: true } : { inLibrary: true })

            if (!prev.has(item.asin)) {
                const ts = item.addedAt || now
                if (recordChange({ kind: addedKind, ts, asin: item.asin }).inserted) added++
            }

            if (snapshot && (item.positionSec != null || item.percentComplete != null)) {
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
            setMembership(asin, list === "wishlist" ? { onWishlist: false } : { inLibrary: false })
            if (recordChange({ kind: removedKind, ts: now, asin }).inserted) removed++
        }
    })()

    return { total: items.length, added, removed, snapshots }
}

export async function syncLibrary() {
    const result = await syncList({
        list: "library",
        fetch: fetchLibrary,
        addedKind: "library-added",
        removedKind: "library-removed",
        snapshot: true,
    })
    setSyncState("last_library_sync", new Date().toISOString())
    console.log(`📚 library: ${result.total} books · +${result.added} -${result.removed} · ${result.snapshots} progress snapshots`)
    return result
}

export async function syncWishlist() {
    const result = await syncList({
        list: "wishlist",
        fetch: fetchWishlist,
        addedKind: "wishlist-added",
        removedKind: "wishlist-removed",
        snapshot: false,
    })
    setSyncState("last_wishlist_sync", new Date().toISOString())
    console.log(`⭐ wishlist: ${result.total} items · +${result.added} -${result.removed}`)
    return result
}
