import { library, wishlist } from "audible-api-ts"

import { loadCredentials, saveCredentials } from "../auth.js"

// Thin wrapper over audible-api-ts. Normalizes an AudibleItem into the stable
// fields auklet stores, and derives a best-effort listening position:
//
//   position_sec = duration_sec - time_remaining_seconds   (preferred, precise)
//                = round(percent_complete/100 * duration_sec)   (fallback, coarse)
//
// All API calls auto-refresh credentials and return the (possibly rotated) set,
// which we persist so tokens stay fresh across restarts.

const iso = (d) =>
    d instanceof Date ? (Number.isNaN(d.getTime()) ? null : d.toISOString())
    : typeof d === "string" ? d
    : null

const dateOnly = (d) => {
    const s = iso(d)
    return s ? s.slice(0, 10) : null
}

function largestImage(images) {
    if (!images || typeof images !== "object") return null
    const numeric = Object.keys(images).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => b - a)
    if (numeric.length) return images[String(numeric[0])]
    const vals = Object.values(images)
    return vals.length ? vals[0] : null
}

export function normalizeItem(item) {
    const durationSec = item.durationMinutes != null ? Math.round(item.durationMinutes * 60) : null
    const ls = item.listeningStatus ?? {}
    const percentComplete = ls.percentComplete ?? null
    const timeRemainingSeconds = ls.timeRemainingSeconds ?? null

    let positionSec = null
    if (durationSec != null && timeRemainingSeconds != null) {
        positionSec = Math.max(0, Math.min(durationSec, durationSec - timeRemainingSeconds))
    } else if (durationSec != null && percentComplete != null) {
        positionSec = Math.round((percentComplete / 100) * durationSec)
    }

    return {
        asin: item.asin,
        title: item.title ?? null,
        subtitle: item.subtitle ?? null,
        authors: item.authors ?? [],
        narrators: item.narrators ?? [],
        seriesTitle: item.series?.name ?? null,
        seriesPosition: item.series?.position != null ? String(item.series.position) : null,
        language: item.language ?? null,
        durationSec,
        releaseDate: dateOnly(item.releaseDate),
        publisher: item.publisher ?? null,
        coverUrl: item.coverUrl ?? largestImage(item.productImages) ?? null,
        percentComplete,
        isFinished: Boolean(ls.isFinished),
        finishedAt: iso(ls.finishedAt),
        timeRemainingSeconds,
        positionSec,
        // verbatim provider timestamps for the library-added natural key
        addedAt: iso(item.dateAdded) ?? iso(item.purchaseDate) ?? null,
    }
}

export async function fetchLibrary() {
    const creds = await loadCredentials()
    const { items, credentials } = await library(creds)
    await saveCredentials(credentials)
    return items.map(normalizeItem)
}

export async function fetchWishlist() {
    const creds = await loadCredentials()
    const { items, credentials } = await wishlist(creds)
    await saveCredentials(credentials)
    return items.map(normalizeItem)
}
