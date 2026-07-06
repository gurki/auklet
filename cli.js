#!/usr/bin/env bun

// Thin HTTP client for the running auklet daemon, plus the interactive `login`
// command (which talks to Audible directly, not the daemon). The daemon is the
// single executor (db + audible credentials); most commands just call its
// endpoints and render the results.

import { login as audibleLogin, register } from "audible-api-ts"
import readline from "node:readline/promises"
import { stdin, stdout } from "node:process"

import { saveCredentials } from "./src/auth.js"

const BASE_URL = process.env.AUKLET_URL || `http://127.0.0.1:${process.env.PORT || 8899}`

function parseFlags(args) {
    const flags = {}
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (!arg.startsWith("--")) continue
        const eq = arg.indexOf("=")
        if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1)
        else if (i + 1 < args.length && !args[i + 1].startsWith("--")) flags[arg.slice(2)] = args[++i]
        else flags[arg.slice(2)] = true
    }
    return flags
}

function printTable(rows, columns) {
    if (rows.length === 0) return console.log("(empty)")
    const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)))
    const line = (cells) => cells.map((cell, i) => String(cell ?? "").padEnd(widths[i])).join("  ")
    console.log(line(columns))
    console.log(widths.map((w) => "─".repeat(w)).join("──"))
    for (const row of rows) console.log(line(columns.map((c) => row[c])))
}

const hms = (sec) => {
    if (sec == null) return ""
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60)
    return h ? `${h}h${String(m).padStart(2, "0")}` : `${m}m`
}

async function call(method, path, flags = {}) {
    const url = new URL(path, BASE_URL)
    for (const [key, value] of Object.entries(flags)) {
        if (key !== "json" && value !== undefined) url.searchParams.set(key, value)
    }
    let res
    try {
        res = await fetch(url, { method })
    } catch {
        console.error(`❌ auklet daemon unreachable at ${BASE_URL} - is it running? (AUKLET_URL to override)`)
        process.exit(1)
    }
    const body = await res.json().catch(() => null)
    if (!res.ok && res.status !== 202) {
        console.error(`❌ ${res.status}:`, body?.error ?? res.statusText)
        process.exit(1)
    }
    return { status: res.status, body }
}

// Extract the authorization code from the pasted post-login redirect URL
// (…/ap/maplanding?openid.oa2.authorization_code=…), or accept a raw code.
function extractCode(input) {
    const trimmed = input.trim()
    if (!trimmed.includes("://") && !trimmed.includes("=")) return trimmed
    try {
        const url = new URL(trimmed)
        return url.searchParams.get("openid.oa2.authorization_code")
            ?? url.searchParams.get("authorization_code") ?? null
    } catch {
        const m = trimmed.match(/authorization_code=([^&\s]+)/)
        return m ? decodeURIComponent(m[1]) : null
    }
}

const commands = {
    "login": async () => {
        const locale = process.env.AUDIBLE_LOCALE || "de"
        const { loginUrl, session } = await audibleLogin(locale)
        console.log(`\n🐦 auklet login (marketplace: ${locale})\n`)
        console.log("1. open this URL in a browser and sign in to Audible/Amazon:\n")
        console.log("   " + loginUrl + "\n")
        console.log("2. after signing in you land on a blank/error page. copy its FULL")
        console.log("   URL from the address bar and paste it below.\n")
        const rl = readline.createInterface({ input: stdin, output: stdout })
        const answer = await rl.question("paste redirect URL (or code): ")
        rl.close()
        const code = extractCode(answer)
        if (!code) { console.error("\n❌ no authorization code found in that input"); return 1 }
        const creds = await register(code, session)
        await saveCredentials(creds)
        console.log("\n✅ authenticated - credentials saved to db/audible-auth.json")
        console.log("   start the daemon with `bun index.js` (or `docker compose up -d`)")
        return 0
    },

    "sync-library": async (flags) => {
        const { body } = await call("POST", "/ops/sync-library", flags)
        console.log(`✅ library: ${body.total} books · +${body.added} -${body.removed} · ${body.snapshots} snapshots`)
        return 0
    },

    "derive-sessions": async (flags) => {
        const { body } = await call("POST", "/ops/derive-sessions", flags)
        console.log(`✅ derived ${body.created} new listen sessions${flags.rebuild ? " (rebuilt from snapshots)" : ""}`)
        return 0
    },

    "backfill": async (flags) => {
        const { body } = await call("POST", "/ops/sync-stats", flags)
        console.log(`✅ backfilled ${body.months} months of listening · ${body.finishedBooks} finished books (${body.finishMarkers} new markers)`)
        return 0
    },

    "activity": async (flags) => {
        const { body } = await call("GET", "/listening-stats", flags)
        if (flags.json) return console.log(JSON.stringify(body, null, 2)) ?? 0
        const max = Math.max(1, ...body.monthly.map((m) => m.seconds))
        for (const m of body.monthly) {
            console.log(`${m.period}  ${"█".repeat(Math.round((m.seconds / max) * 40))} ${hms(m.seconds)}`)
        }
        return 0
    },

    "verify": async (flags) => {
        const { body } = await call("POST", "/ops/verify", flags)
        if (flags.json) return console.log(JSON.stringify(body, null, 2)) ?? 0
        for (const c of body.checks) console.log(`${c.ok ? "✅" : "❌"} ${c.name}: ${c.detail}`)
        console.log(body.ok ? "\n✅ all checks passed" : "\n❌ issues found")
        return body.ok ? 0 : 2
    },

    "journey-sync": async (flags) => {
        const { body } = await call("POST", "/ops/journey-sync", flags)
        console.log(`✅ pushed ${body.books} books + ${body.listens} listens + ${body.libraryEvents} library events ` +
            `(${body.accepted} accepted, ${body.superseded} superseded, ${body.rejected.length} rejected) · ` +
            `blobs: ${body.blobsUploaded} uploaded, ${body.blobsSkipped} present`)
        return body.rejected.length ? 2 : 0
    },

    "hydrate": async (flags) => {
        const { body } = await call("POST", "/ops/hydrate", flags)
        console.log(`⏳ hydrate started (job ${body.id})`)
        for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 2000))
            const { body: job } = await call("GET", `/ops/jobs/${body.id}`)
            if (job.progress) process.stdout.write(`\r${job.progress}    `)
            if (job.status !== "running") {
                console.log(`\n${job.status === "done" ? "✅" : "❌"} hydrate ${job.status}`,
                    job.result ? JSON.stringify(job.result) : job.error ?? "")
                return job.status === "done" ? 0 : 1
            }
        }
    },

    "stats": async (flags) => {
        const { body } = await call("GET", "/stats", flags)
        if (flags.json) return console.log(JSON.stringify(body, null, 2)) ?? 0
        const t = body.totals
        console.log(`library ${t.library} · finished ${t.finished}`)
        console.log(`observed sessions ${t.sessions} · observed listening ${hms(t.listenedSec)}`)
        console.log(`lifetime listened (audible stats): ${hms(t.lifetimeListenedSec)}`)
        console.log(`last library sync: ${body.lastLibrarySync ?? "never"} · last stats backfill: ${body.lastStatsSync ?? "never"}\n`)
        printTable(body.listenedPerMonth.map((m) => ({ month: m.month, sessions: m.sessions, listened: hms(m.listenedSec) })),
            ["month", "sessions", "listened"])
        console.log("")
        printTable(body.topAuthors, ["author", "books"])
        return 0
    },

    "books": async (flags) => {
        const { body } = await call("GET", "/books", flags)
        if (flags.json) return console.log(JSON.stringify(body, null, 2)) ?? 0
        printTable(body.books.map((b) => ({
            title: b.title, authors: JSON.parse(b.authors ?? "[]").join(", "),
            progress: b.progress_label ?? "unknown",
        })), ["title", "authors", "progress"])
        return 0
    },

    "sessions": async (flags) => {
        const { body } = await call("GET", "/sessions", flags)
        if (flags.json) return console.log(JSON.stringify(body, null, 2)) ?? 0
        printTable(body.sessions.map((s) => ({
            started: s.local_time ?? s.started_at, title: s.title,
            listened: hms(s.listened_sec), finished: s.finished ? "✓" : "",
        })), ["started", "title", "listened", "finished"])
        return 0
    },

    "events": async (flags) => {
        const { body } = await call("GET", "/events", flags)
        if (flags.json) return console.log(JSON.stringify(body, null, 2)) ?? 0
        printTable(body.events.map((e) => ({
            local: e.local_time ?? e.triggered_at, kind: e.kind, title: e.title ?? e.book_asin,
        })), ["local", "kind", "title"])
        return 0
    },
}

function usage() {
    console.log(`🐦 auklet - audible watchdog

usage: auklet <command> [flags]

commands:
  login                            authenticate with audible (interactive browser flow)
  sync-library                     refresh the library from audible (rebuild current state)
  derive-sessions [--rebuild]      (re)build listen sessions from progress snapshots
  backfill                         import historical finish dates + listening time from audible stats
  activity                         monthly listening time (from audible stats history)
  verify [--strict] [--deep]       consistency + integrity checks (exit 2 on issues)
  journey-sync [--full]            push books, listens, library events + covers to journey
  hydrate                          download cover art for new books
  stats                            library / finished / listening totals, top authors
  books [--q] [--sort author|series|progress|recent|title]
  sessions [--month] [--part morning|afternoon|evening|night] [--q]
  events [--kind] [--month]        the library change log

env: AUKLET_URL (default http://127.0.0.1:8899), AUDIBLE_LOCALE (default de)`)
    return 1
}

const [command, ...rest] = process.argv.slice(2)
const handler = commands[command]
process.exitCode = handler ? await handler(parseFlags(rest)) : usage()
