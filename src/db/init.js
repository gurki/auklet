import { mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { openDatabase } from "./driver.js"
import { applyMigrations } from "./migrate.js"

const DEFAULT_PATH = join(resolve(import.meta.dirname, "../../db"), "auklet.db")

let db = null

export function getDb() {
    if (db) return db

    const path = process.env.AUKLET_DB_PATH || DEFAULT_PATH
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })

    db = openDatabase(path)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA foreign_keys = ON")
    db.exec("PRAGMA busy_timeout = 5000")
    applyMigrations(db)
    return db
}

export function closeDb() {
    if (!db) return
    db.close()
    db = null
}
