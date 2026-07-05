// Local-time bucketing for events and listen sessions. An observation belongs
// to the calendar month/day in the configured home timezone, not UTC - a
// listen at 00:30 CEST on July 1st counts as July. Audible reports UTC (or
// Date objects); this applies the home timezone. SQLite can't do IANA/DST
// math, so month + local_time are precomputed here at record time.

export const TIME_ZONE = process.env.AUKLET_TZ || "Europe/Berlin"

// en-CA formats as YYYY-MM, which sorts correctly as a string
const monthFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
})

export function localMonth(isoTimestamp) {
    const date = new Date(isoTimestamp)
    if (Number.isNaN(date.getTime())) throw new Error(`invalid timestamp: ${isoTimestamp}`)
    return monthFmt.format(date)
}

// Wall-clock parts + the zone's UTC offset for a given instant. Intl resolves
// DST correctly for historical timestamps, which SQLite cannot do.
const localFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
})

// Full local timestamp with numeric offset, e.g. 2026-07-04T08:15:00+02:00.
export function localTime(isoTimestamp) {
    const date = new Date(isoTimestamp)
    if (Number.isNaN(date.getTime())) throw new Error(`invalid timestamp: ${isoTimestamp}`)

    const parts = {}
    for (const p of localFmt.formatToParts(date)) parts[p.type] = p.value

    // longOffset gives "GMT+02:00" / "GMT" (UTC); normalise to +HH:MM / Z
    const raw = (parts.timeZoneName || "GMT").replace("GMT", "")
    const offset = raw === "" ? "Z" : (raw.length === 3 ? `${raw}:00` : raw)

    // en-CA hour can render midnight as "24"; clamp to "00"
    const hour = parts.hour === "24" ? "00" : parts.hour
    return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${offset}`
}
