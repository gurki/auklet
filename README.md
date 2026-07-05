# auklet 🐦

an audible watchdog and local database for audiobook library changes 📚 and listening progress 🎧.

auklet watches your audible account, records every library, wishlist, and progress change as an event in a local sqlite database, and can rebuild its current state from the audible api at any time. the database is the journal; audible is the source of truth.

It is the audiobook sibling of [spike](../spike) (the Spotify watchdog), and can optionally push its data to a [Journey](../24w03-heros-path) server as `audiobook.*` items.

---

## Quick start

Requires [Bun](https://bun.sh) (uses `bun:sqlite`; no native build).

```sh
bun install
cp .env.example .env          # set AUDIBLE_LOCALE to your marketplace (de, com, co.uk, …)

bun cli.js login              # interactive: open the URL, sign in, paste the redirect URL back
bun index.js                  # start the watchdog
```

Then open <http://127.0.0.1:8899/browse>.

### Login

Audible has no public API, so auklet authenticates the same way the mobile apps
do: PKCE device registration ([audible-api-ts](https://github.com/moifort/audible-api-ts)).
`bun cli.js login` prints an Amazon sign-in URL — open it in a browser, sign in
(handling any CAPTCHA/OTP there), and you'll be redirected to a blank/"error"
page. Copy that page's **full URL** from the address bar and paste it back. The
resulting credentials are saved to `db/audible-auth.json` and auto-refreshed.

---

## How it works

Audible only exposes *state* (your current library, wishlist, and per-book
progress), not a play-history feed. So auklet **polls and diffs snapshots over
time**, recording change *history* into an append-only journal while treating
Audible as the rebuildable source of truth.

**Events** — every poll re-fetches the full library + wishlist and diffs them
against the local membership set:

| kind | when |
|------|------|
| `library-added` 📚 | a book enters your library (first sync backfills with Audible's own purchase/added date) |
| `library-removed` | a book leaves your library |
| `wishlist-added` / `wishlist-removed` | wishlist membership changes |

**Listen sessions** 🎧 — each poll appends an immutable `progress_snapshots` row
for any book whose position advanced (position comes from `duration −
time_remaining`, falling back to `percent × duration`). `deriveSessions` then
stitches consecutive snapshots into listen sessions — *"listened to this book
from time A to time B, N seconds of audio"* — splitting on gaps longer than
`SESSION_GAP_S`. Sessions are pure derived state and can be rebuilt from the
snapshots at any time (`derive-sessions --rebuild`). A book's pre-existing
progress at first sight is a baseline and is never counted as a listen.

Item IDs are deterministic (`audiobook.book` from `audible|<asin>`,
`audiobook.listen` from `audible|<endedAt>|<asin>`), so restarts and full
re-syncs upsert rather than duplicate.

---

## CLI

The daemon is the single executor; the CLI is a thin HTTP client (except
`login`, which talks to Audible directly).

```
auklet login                        authenticate with audible
auklet sync-library                 refresh library from audible (rebuild current state)
auklet sync-wishlist                refresh wishlist
auklet derive-sessions [--rebuild]  (re)build listen sessions from snapshots
auklet verify [--strict] [--deep]   consistency + integrity checks
auklet journey-sync [--full]        push books, listens, library events + covers to journey
auklet hydrate                      download cover art for new books
auklet stats                        library / wishlist / listen totals, top authors
auklet books [--q] [--list library|wishlist] [--stalled]
auklet sessions [--month] [--part morning|afternoon|evening|night] [--q]
auklet events [--kind] [--month]    the library/wishlist change log
```

`AUKLET_URL` (default `http://127.0.0.1:8899`) targets a remote daemon.

---

## Journey sync (optional)

Set `JOURNEY_URL`, `JOURNEY_TOKEN`, `JOURNEY_CLIENT_ID` in `.env` and the daemon
pushes (debounced, after each poll) to a Journey server as `audiobook.book`,
`audiobook.listen`, and `audiobook.library_event` items, uploading cover blobs
first. Install the module on the server so it accepts them:

```sh
# from the journey server repo
curl -X POST "$JOURNEY_URL/api/modules/install" ... ../24w03-heros-path/modules/audiobooks
```

Pushes are idempotent (deterministic IDs, cursor-based), so re-running is safe.

---

## Deployment

**Docker Compose** (recommended). Authenticate once (writes into the bind-mounted `db/`), then bring it up:

```sh
docker compose run --rm auklet bun cli.js login
docker compose up -d --build
```

**systemd** — see [deploy/auklet.service](deploy/auklet.service).

---

## Configuration

See [.env.example](.env.example). Key knobs: `AUDIBLE_LOCALE` (marketplace),
`AUKLET_TZ` (bucketing), `PROGRESS_INTERVAL_S` (poll cadence), `SESSION_GAP_S`
(session split threshold).
