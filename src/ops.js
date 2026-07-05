import { syncLibrary, syncWishlist, syncStats } from "./sync.js"
import { deriveSessions } from "./sessions.js"

// The daemon is the single executor: one op at a time, watcher-triggered
// polls queue behind manual ops instead of interleaving.
let chain = Promise.resolve()

export function withLock(fn) {
    const run = chain.then(fn, fn)
    chain = run.catch(() => {})
    return run
}

// Minimal job registry for long-running ops (hydrate).
const jobs = new Map()
let jobCounter = 0

export function startJob(name, fn) {
    const id = `${name}-${++jobCounter}`
    const job = { id, name, status: "running", startedAt: new Date().toISOString(), progress: null, result: null, error: null }
    jobs.set(id, job)

    withLock(fn)
        .then((result) => { job.status = "done"; job.result = result })
        .catch((error) => { job.status = "failed"; job.error = error.message })
        .finally(() => { job.finishedAt = new Date().toISOString() })

    return job
}

export const getJob = (id) => jobs.get(id) ?? null

export function jobProgress(id, progress) {
    const job = jobs.get(id)
    if (job) job.progress = progress
}

// --- operations ----------------------------------------------------------

// Full refresh of library / wishlist from the source of truth. Same code as
// the periodic poll, so it doubles as "rebuild current state from the API".
export { syncLibrary, syncWishlist, syncStats, deriveSessions }

export async function verify(flags = {}) {
    const { verify: impl } = await import("./verify.js")
    return impl(flags)
}

// Push canonical data to the journey server (idempotent, cursor-based).
export async function journeySync(flags = {}) {
    const { journeySync: impl } = await import("./journey.js")
    return impl(flags)
}

// Long-running: run as a job, poll via GET /ops/jobs/:id.
export function startHydrate() {
    let job = null
    job = startJob("hydrate", async () => {
        const { hydrate } = await import("./hydrate.js")
        return hydrate({ onProgress: (progress) => jobProgress(job.id, progress) })
    })
    return job
}
