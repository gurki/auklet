import { MIGRATIONS } from "./schema.js"

export function applyMigrations(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT DEFAULT (datetime('now'))
        )
    `)

    const current = db.prepare("SELECT COALESCE(MAX(version), 0) v FROM migrations").get().v
    const known = Math.max(...MIGRATIONS.map((m) => m.version))
    if (current > known) {
        throw new Error(`database is at schema v${current}, binary only knows v${known} - refusing to run`)
    }

    const record = db.prepare("INSERT INTO migrations (version, name) VALUES (?, ?)")
    for (const migration of MIGRATIONS) {
        if (migration.version <= current) continue
        db.transaction(() => {
            migration.up(db)
            record.run(migration.version, migration.name)
        })()
        console.log(`🗄️ applied migration v${migration.version} (${migration.name})`)
    }
}
