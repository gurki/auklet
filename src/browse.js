// Single-file browse UI served by the daemon: a library grid, a listen/finish
// history, and monthly activity. No build step, vanilla JS, dark theme.

export const BROWSE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>auklet 🐦</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root {
    color-scheme: dark;
    --bg: #121212;
    --panel: #171717;
    --surface: #1b1b1b;
    --surface-2: #202020;
    --line: #2c2c2c;
    --line-strong: #3a3a3a;
    --text: #ececec;
    --muted: #9a9a9a;
    --dim: #686868;
    --accent: #2e5c3f;
    --accent-hot: #4eb36f;
    --warm: #d5973f;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--text); }
  header { position: sticky; top: 0; z-index: 5; display: flex; gap: 14px; align-items: center;
    padding: 12px 18px; background: var(--panel); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  header h1 { font-size: 17px; line-height: 1; margin: 0; font-weight: 650; }
  .tabs { display: flex; gap: 4px; }
  .tab { min-height: 36px; display: flex; align-items: center; padding: 6px 12px; border-radius: 8px;
    cursor: pointer; color: var(--muted); user-select: none; font-weight: 600; }
  .tab:hover { background: var(--surface-2); color: var(--text); }
  .tab.on { background: var(--accent); color: #fff; }
  input, select { min-height: 36px; background: var(--surface); border: 1px solid var(--line); color: var(--text);
    padding: 6px 10px; border-radius: 8px; font: inherit; outline: none; }
  input { flex: 1 1 280px; min-width: 160px; }
  input:focus, select:focus { border-color: var(--line-strong); box-shadow: 0 0 0 2px rgba(78, 179, 111, 0.16); }
  main { padding: 18px; }
  .muted { color: var(--muted); }
  #summary { margin-left: auto; white-space: nowrap; font-size: 13px; }
  #journey { display: flex; align-items: center; gap: 5px; white-space: nowrap; font-size: 12px; }
  #journey i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-hot); }
  #journey.pending i { background: var(--dim); }
  [hidden] { display: none !important; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 16px; }
  .card { min-width: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; overflow: hidden;
    transition: border-color 120ms ease, background 120ms ease; }
  .card:hover { border-color: var(--accent); background: var(--surface-2); }
  .card img, .noart { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; background: var(--surface-2); }
  .noart { display: flex; align-items: center; justify-content: center; font-size: 34px; color: #505050; }
  .card .b { padding: 9px 10px 10px; }
  .card .t { font-size: 13px; font-weight: 600; line-height: 1.3; max-height: 2.6em; overflow: hidden; }
  .card .a { font-size: 12px; color: var(--muted); margin-top: 3px; max-height: 1.5em; overflow: hidden; }
  .bar { height: 4px; background: #2f2f2f; border-radius: 3px; margin-top: 8px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: var(--warm); }
  .bar > i.fin { background: var(--accent-hot); }
  .pct { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .done { color: var(--accent-hot); }
  main.timeline { max-width: 720px; margin: 0 auto; padding: 18px 16px 60px; }
  .day { position: sticky; top: 61px; padding: 10px 4px 6px; font-size: 12px; font-weight: 700;
    color: #c8c8c8; background: var(--bg); }
  .row { display: flex; gap: 10px; align-items: center; padding: 6px 8px; border-radius: 8px; }
  .row:hover { background: var(--surface); }
  .row img, .row .noart { width: 40px; height: 40px; flex: 0 0 40px; border-radius: 5px; aspect-ratio: auto; }
  .row .meta { flex: 1; min-width: 0; }
  .row .t { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .sub { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .amt { font-variant-numeric: tabular-nums; color: var(--warm); font-weight: 600; white-space: nowrap; }
  button.more { margin: 18px auto; display: block; background: var(--surface); border: 1px solid var(--line);
    color: var(--text); padding: 8px 18px; border-radius: 8px; cursor: pointer; }
  button.more:hover { background: var(--surface-2); border-color: var(--line-strong); }
  .activity { max-width: 760px; margin: 0 auto; }
  .activity .total { font-size: 15px; color: #c8c8c8; margin-bottom: 14px; }
  .mrow { display: flex; align-items: center; gap: 10px; padding: 3px 0; }
  .mo { width: 62px; color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .mbar { flex: 1; height: 14px; background: var(--surface); border-radius: 4px; overflow: hidden; }
  .mbar > i { display: block; height: 100%; background: var(--warm); }
  .mv { width: 74px; text-align: right; font-size: 13px; font-variant-numeric: tabular-nums; }
  .cap { color: var(--muted); font-size: 12px; margin: 0 4px 4px; }
  .amt.fin { color: var(--accent-hot); font-weight: 600; }

  @media (max-width: 620px) {
    header { gap: 10px; padding: 10px 12px; }
    header h1 { flex-basis: 100%; }
    input { order: 4; flex-basis: 100%; }
    #summary { margin-left: 0; }
    main { padding: 12px; }
    .grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
  }
</style>
</head>
<body>
<header>
  <h1>auklet 🐦</h1>
  <div class="tabs">
    <div class="tab on" data-view="library">library</div>
    <div class="tab" data-view="history">history</div>
    <div class="tab" data-view="activity">activity</div>
  </div>
  <input id="q" placeholder="search title / author…">
  <select id="sort" title="sort">
    <option value="author">author</option>
    <option value="progress">progress</option>
    <option value="recent">recently added</option>
    <option value="title">title</option>
  </select>
  <span id="journey" class="muted" hidden><i></i><span></span></span>
  <span id="summary" class="muted"></span>
</header>
<main id="main"></main>

<script>
const main = document.getElementById("main")
const qEl = document.getElementById("q")
const sortEl = document.getElementById("sort")
const summary = document.getElementById("summary")
const journeyEl = document.getElementById("journey")
let view = "library"
let offset = 0

const DAY_MS = 86400000
function dayLabel(iso) {
  const today = new Date(); today.setHours(0,0,0,0)
  const d = new Date(iso.slice(0,10) + "T00:00:00")
  const diff = Math.round((today - d) / DAY_MS)
  if (diff === 0) return "Today"
  if (diff === 1) return "Yesterday"
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })
}
function hms(sec) {
  if (sec == null) return ""
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60)
  return h ? h + "h " + String(m).padStart(2,"0") + "m" : m + "m"
}
function art(sha, cls) {
  const c = cls || ""
  return sha ? '<img class="'+c+'" loading="lazy" src="/cover/'+sha+'">' : '<div class="noart '+c+'">🎧</div>'
}
function authorsOf(json) { try { return JSON.parse(json||"[]").join(", ") } catch { return "" } }

function relativeTime(iso) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + "m ago"
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + "h ago"
  return Math.floor(hours / 24) + "d ago"
}

async function loadJourneyStatus() {
  const { journey } = await fetch("/stats").then(r => r.json())
  if (!journey) return
  journeyEl.hidden = false
  journeyEl.classList.toggle("pending", !journey.lastSyncAt)
  journeyEl.querySelector("span").textContent = journey.lastSyncAt
    ? "journey · synced " + relativeTime(journey.lastSyncAt)
    : "journey · not synced"
  const mode = journey.automatic ? "automatic sync" : "manual sync"
  journeyEl.title = journey.lastSyncAt
    ? mode + " · last successful sync: " + journey.lastSyncAt
    : mode + " · no successful Journey sync yet"
}

async function loadGrid() {
  const params = new URLSearchParams({ list: "library", limit: 500, sort: sortEl.value || "author" })
  if (qEl.value) params.set("q", qEl.value)
  const { books } = await fetch("/books?" + params).then(r => r.json())
  summary.textContent = books.length + " books"
  main.className = "grid"
  main.innerHTML = books.map(b => {
    const status = b.progress_status || "unknown"
    const pct = b.progress_percent
    const bar = status === "unknown" ? ""
      : '<div class="bar"><i class="' + (status === "finished" ? "fin" : "") + '" style="width:'+pct+'%"></i></div>'
    const state = status === "finished" ? '<div class="pct done">finished'+(b.finished_at ? ' · '+b.finished_at.slice(0,10) : '')+'</div>'
      : status === "in_progress" ? '<div class="pct">'+pct+'% complete</div>'
      : '<div class="pct muted" title="No trusted progress signal for this title">unknown</div>'
    return '<div class="card">' + art(b.cover_sha256) +
      '<div class="b"><div class="t">'+ (b.title||"") +'</div><div class="a">'+ authorsOf(b.authors) +'</div>'
      + bar + state + '</div></div>'
  }).join("") || '<p class="muted">nothing here yet — run <code>auklet sync-library</code></p>'
}

async function loadHistory(append) {
  if (!append) { offset = 0; main.innerHTML = ""; main.className = "timeline" }
  const params = new URLSearchParams({ limit: 200, offset, hideUnknown: "1" })
  if (qEl.value) params.set("q", qEl.value)
  const { sessions } = await fetch("/sessions?" + params).then(r => r.json())
  summary.textContent = view === "history" ? "listen history" : ""
  let html = ""
  let lastDay = main.dataset.lastDay || ""
  for (const s of sessions) {
    const key = (s.local_time || s.ended_at || "").slice(0,10)
    if (key !== lastDay) { html += '<div class="day">'+ dayLabel(s.local_time || s.ended_at) +'</div>'; lastDay = key }
    if (s.display_confidence === "exact") {
      // finish marker back-dated from Audible stats: exact date, no observed listening
      html += '<div class="row">'+ art(s.cover_sha256) +
        '<div class="meta"><div class="t">'+ (s.title||"") +'</div>'+
        '<div class="sub">'+ authorsOf(s.authors) +'</div></div>'+
        '<div class="amt fin">✓ finished</div></div>'
    } else {
      // inferred from progress polling: time and duration are estimates
      const time = (s.local_time || s.started_at || "").slice(11,16)
      html += '<div class="row" title="estimated from progress polling (±poll interval)">'+ art(s.cover_sha256) +
        '<div class="meta"><div class="t">'+ (s.title||"") +'</div>'+
        '<div class="sub">'+ authorsOf(s.authors) +' · '+ time +(s.finished?' · finished':'') +'</div></div>'+
        '<div class="amt">'+ hms(s.listened_sec) +'</div></div>'
    }
  }
  main.dataset.lastDay = lastDay
  if (!append) {
    main.innerHTML = html
      ? '<div class="cap">✓ finished = trusted finish date · listening time and clock time are estimated from progress polls</div>' + html
      : '<p class="muted">no listening history yet</p>'
  } else {
    main.insertAdjacentHTML("beforeend", html)
  }
  const old = document.querySelector("button.more"); if (old) old.remove()
  if (sessions.length === 200) {
    const btn = document.createElement("button"); btn.className = "more"; btn.textContent = "load more"
    btn.onclick = () => { offset += 200; loadHistory(true) }
    main.appendChild(btn)
  }
}

async function loadActivity() {
  const { monthly } = await fetch("/listening-stats").then(r => r.json())
  main.className = "activity"
  if (!monthly.length) {
    summary.textContent = ""
    main.innerHTML = '<p class="muted">no listening history yet — run <code>auklet backfill</code></p>'
    return
  }
  const max = Math.max(...monthly.map(m => m.seconds))
  const total = monthly.reduce((s, m) => s + m.seconds, 0)
  summary.textContent = monthly.length + " months"
  main.innerHTML = '<div class="total">'+ hms(total) +' listened on Audible · all books · '+ monthly.length +' months</div>' +
    '<div class="cap">from Audible stats — whole account, not only what auklet observed</div>' +
    monthly.slice().reverse().map(m =>
      '<div class="mrow"><span class="mo">'+ m.period +'</span>'+
      '<span class="mbar"><i style="width:'+ Math.round((m.seconds/max)*100) +'%"></i></span>'+
      '<span class="mv">'+ hms(m.seconds) +'</span></div>'
    ).join("")
}

function render() {
  sortEl.style.display = view === "library" ? "" : "none"
  main.dataset.lastDay = ""
  if (view === "history") loadHistory(false)
  else if (view === "activity") loadActivity()
  else loadGrid()
}

document.querySelectorAll(".tab").forEach(tab => tab.onclick = () => {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("on"))
  tab.classList.add("on"); view = tab.dataset.view; render()
})
let debounce
qEl.oninput = () => { clearTimeout(debounce); debounce = setTimeout(render, 250) }
sortEl.onchange = render
loadJourneyStatus().catch(() => {})
render()
</script>
</body>
</html>`
