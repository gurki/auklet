import fs from "node:fs/promises"
import { existsSync } from "node:fs"

// Audible credential lifecycle. Unlike spike's Spotify OAuth (a server-side
// redirect flow), Audible uses PKCE device registration driven interactively
// from the CLI (`auklet login`): the user signs in through a browser and pastes
// the redirect URL back. The resulting credentials (access/refresh tokens, the
// device RSA private key and adp_token used to sign API requests) are persisted
// here and reused by the daemon. library()/wishlist() auto-refresh and return
// updated credentials, which the provider layer writes back via saveCredentials.

const AUTH_FILE = process.env.AUKLET_AUTH_FILE || "db/audible-auth.json"

export function hasCredentials() {
    return existsSync(AUTH_FILE)
}

export async function loadCredentials() {
    if (!existsSync(AUTH_FILE)) {
        throw new Error(`not authenticated - run \`auklet login\` (missing ${AUTH_FILE})`)
    }
    const creds = JSON.parse(await fs.readFile(AUTH_FILE, "utf8"))
    // expiresAt round-trips through JSON as a string; the library expects a Date.
    if (creds.expiresAt) creds.expiresAt = new Date(creds.expiresAt)
    return creds
}

export async function saveCredentials(creds) {
    if (!existsSync("db")) await fs.mkdir("db", { recursive: true })
    await fs.writeFile(AUTH_FILE, JSON.stringify(creds, null, 2))
    return creds
}
