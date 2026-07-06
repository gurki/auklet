import { createSign } from "node:crypto"

import { library, refresh, AUDIBLE_LOCALES } from "audible-api-ts"

import { loadCredentials, saveCredentials } from "../auth.js"

const REFRESH_BUFFER_MS = 5 * 60 * 1000

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

// --- signed raw requests -----------------------------------------------------
// audible-api-ts doesn't wrap the /1.0/stats/* endpoints, so we replicate its
// request signing (x-adp-token + RSA-SHA256 over method\npath\ndate\nbody\n
// adpToken) to reach them - the only source of *historical* listening data
// (the library API gives current position only). Reuses the library's refresh
// + locale config.

function signHeaders(method, path, body, creds) {
    const date = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
    const data = `${method}\n${path}\n${date}\n${body}\n${creds.adpToken}`
    const signer = createSign("SHA256")
    signer.update(data)
    const signature = signer.sign(creds.devicePrivateKey, "base64")
    return { "x-adp-token": creds.adpToken, "x-adp-alg": "SHA256withRSA:1.0", "x-adp-signature": `${signature}:${date}` }
}

async function apiGet(path, query) {
    let creds = await loadCredentials()
    if (creds.expiresAt.getTime() - Date.now() < REFRESH_BUFFER_MS) {
        creds = await refresh(creds)
        await saveCredentials(creds)
    }
    const domain = AUDIBLE_LOCALES[creds.locale].domain
    const qs = query
        ? "?" + Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join("&")
        : ""
    const full = `/1.0${path}${qs}`
    const res = await fetch(`https://api.audible.${domain}${full}`, { headers: signHeaders("GET", full, "", creds) })
    if (!res.ok) throw new Error(`audible api ${res.status} ${res.statusText} (${path})`)
    return res.json()
}

const ym = (d) => d.toISOString().slice(0, 7)

// All historical "marked as finished" events -> Map<asin, latest finishedAt ISO>,
// paginating the continuation_token back to the start of the account.
export async function fetchFinished() {
    const byAsin = new Map()
    let token = null
    for (let page = 0; page < 200; page++) {
        const data = await apiGet("/stats/status/finished", {
            start_date: "2000-01-01T00:00:00Z",
            continuation_token: token,
        })
        const list = data.mark_as_finished_status_list ?? []
        for (const e of list) {
            if (e.is_marked_as_finished && e.asin && e.event_timestamp) {
                const prev = byAsin.get(e.asin)
                if (!prev || e.event_timestamp > prev) byAsin.set(e.asin, e.event_timestamp)
            }
        }
        token = data.continuation_token
        if (!token || list.length === 0) break
    }
    return byAsin
}

// Historical monthly listening time (seconds) back to the account start:
// 12-month windows, stop after two empty windows. This is Audible's own
// account-wide total (all books/devices), not per-book.
export async function fetchListeningStats({ maxMonths = 300 } = {}) {
    const monthly = new Map() // YYYY-MM -> seconds
    const toSec = (ms) => Math.round(Number(ms) / 1000)

    let consecutiveEmpty = 0
    for (let offset = 0; offset < maxMonths; offset += 12) {
        const start = new Date()
        start.setUTCDate(1)
        start.setUTCMonth(start.getUTCMonth() - offset - 11)
        const data = await apiGet("/stats/aggregates", {
            response_groups: "total_listening_stats", store: "Audible",
            monthly_listening_interval_start_date: ym(start), monthly_listening_interval_duration: 12,
        })
        const list = data.aggregated_monthly_listening_stats ?? []
        for (const s of list) monthly.set(s.interval_identifier, toSec(s.aggregated_sum))
        if (list.length === 0) { if (++consecutiveEmpty >= 2) break } else consecutiveEmpty = 0
    }

    return { monthly }
}
