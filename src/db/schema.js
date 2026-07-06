// Clean v001 schema. Audible is the source of truth: books + current
// library/wishlist membership + current progress are rebuildable from the API
// at any time. The journal (events, progress_snapshots) is the part that can't
// be reconstructed - it captures change *history* as auklet observes it.
//
// Two kinds of history:
//   - events:            discrete membership changes (library/wishlist add/remove)
//   - progress_snapshots: immutable progress observations; sessions are derived
//                         from them (and fully re-derivable as the heuristic improves)

export const SCHEMA_V001 = `
CREATE TABLE IF NOT EXISTS books (
    asin TEXT PRIMARY KEY,
    title TEXT,
    subtitle TEXT,
    authors TEXT,                       -- JSON array of names
    narrators TEXT,                     -- JSON array of names
    series_title TEXT,
    series_position TEXT,               -- provider 'sequence' verbatim (e.g. "1", "1.5")
    language TEXT,
    duration_sec INTEGER,
    release_date TEXT,                  -- provider string verbatim (self-describing precision)
    publisher TEXT,
    cover_url TEXT,                     -- provenance only; will rot
    cover_sha256 TEXT REFERENCES covers(sha256),
    percent_complete REAL,              -- latest observed
    is_finished INTEGER,                -- latest observed
    in_library INTEGER NOT NULL DEFAULT 0,
    on_wishlist INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    journey_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,                -- deterministic ULID (src/ids.js)
    natural_key TEXT NOT NULL UNIQUE,   -- rebuild idempotence via INSERT OR IGNORE
    kind TEXT NOT NULL CHECK (kind IN (
        'library-added', 'library-removed', 'wishlist-added', 'wishlist-removed'
    )),
    book_asin TEXT NOT NULL,
    triggered_at TEXT NOT NULL,         -- provider/observation timestamp VERBATIM
    month TEXT NOT NULL,                -- YYYY-MM local
    local_time TEXT,
    tz TEXT,
    provider TEXT NOT NULL DEFAULT 'audible',
    raw_snapshot TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_kind_month ON events(kind, month);
CREATE INDEX IF NOT EXISTS idx_events_book ON events(book_asin);
CREATE INDEX IF NOT EXISTS idx_events_triggered ON events(triggered_at);

CREATE TABLE IF NOT EXISTS progress_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_asin TEXT NOT NULL,
    observed_at TEXT NOT NULL,          -- ISO, when auklet polled
    percent_complete REAL,
    position_sec INTEGER,               -- duration_sec - time_remaining, or percent*duration
    delta_sec INTEGER NOT NULL DEFAULT 0, -- audio advance since previous snapshot (0 on baseline)
    is_finished INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_book_observed ON progress_snapshots(book_asin, observed_at);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,                -- = the listen event id (deterministic ULID at ended_at)
    natural_key TEXT NOT NULL UNIQUE,   -- audible|<ended_at>|<asin>
    book_asin TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    position_start_sec INTEGER,
    position_end_sec INTEGER,
    listened_sec INTEGER,               -- audio consumed (position delta), not wall-clock
    month TEXT NOT NULL,
    local_time TEXT,
    tz TEXT,
    finished INTEGER,
    confidence TEXT NOT NULL DEFAULT 'inferred',
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_book ON sessions(book_asin);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

CREATE TABLE IF NOT EXISTS covers (
    sha256 TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    source_url TEXT,
    content_type TEXT,
    bytes INTEGER,
    fetched_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
);
`

// v2: historical backfill from Audible's stats endpoints. books.finished_at
// records when a book was marked finished (back-dated from stats/status/finished,
// years before the watcher existed); listening_stats holds per-day/per-month
// total listening time from stats/aggregates.
const MIGRATE_V002 = `
ALTER TABLE books ADD COLUMN finished_at TEXT;

CREATE TABLE IF NOT EXISTS listening_stats (
    kind TEXT NOT NULL,                 -- 'daily' | 'monthly'
    period TEXT NOT NULL,               -- YYYY-MM-DD | YYYY-MM
    seconds INTEGER NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (kind, period)
);
`

// v3: drop wishlist tracking. auklet focuses on the owned library; wishlist had
// no UI and no real use. Non-destructive: drops the column and any wishlist
// events, but keeps observed snapshots/sessions. The events.kind CHECK still
// harmlessly permits the now-unused wishlist kinds (narrowing it would need a
// full table rebuild); nothing writes them anymore. DROP COLUMN needs SQLite
// >= 3.35, which bun:sqlite has.
const MIGRATE_V003 = `
DELETE FROM events WHERE kind IN ('wishlist-added', 'wishlist-removed');
ALTER TABLE books DROP COLUMN on_wishlist;
`

export const MIGRATIONS = [
    { version: 1, name: "clean_init", up: (db) => db.exec(SCHEMA_V001) },
    { version: 2, name: "stats_backfill", up: (db) => db.exec(MIGRATE_V002) },
    { version: 3, name: "drop_wishlist", up: (db) => db.exec(MIGRATE_V003) },
]
