// The only runtime-specific module in the codebase. Bun cannot load
// better-sqlite3 (native V8 addon, see oven-sh/bun#4290) and 1.3 lacks
// node:sqlite, so: bun:sqlite under Bun, better-sqlite3 under Node. Everything
// else talks to this normalized interface - SQL uses @name parameters, call
// sites pass bare keys.

const isBun = Boolean(process.versions.bun)

const Database = isBun
    ? (await import("bun:sqlite")).Database
    : (await import("better-sqlite3")).default

// bun:sqlite wants named-param keys WITH prefix ("@id"), better-sqlite3
// wants them bare ("id").
function mapParams(params) {
    if (!isBun) return params
    if (params == null || typeof params !== "object" || Array.isArray(params)) return params
    const mapped = {}
    for (const [key, value] of Object.entries(params)) {
        mapped[key.startsWith("@") ? key : `@${key}`] = value
    }
    return mapped
}

const isPlainObject = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value)

class Statement {
    #stmt
    constructor(stmt) { this.#stmt = stmt }
    #args(args) { return args.length === 1 && isPlainObject(args[0]) ? [mapParams(args[0])] : args }
    run(...args) { return this.#stmt.run(...this.#args(args)) }
    get(...args) { return this.#stmt.get(...this.#args(args)) }
    all(...args) { return this.#stmt.all(...this.#args(args)) }
}

export function openDatabase(path) {
    const db = new Database(path)
    return {
        exec: (sql) => db.exec(sql),
        prepare: (sql) => new Statement(db.prepare(sql)),
        transaction: (fn) => db.transaction(fn),
        close: () => db.close(),
    }
}
