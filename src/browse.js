// Single-file browse UI served by the daemon: a library grid, a day-grouped
// listen history, and a "stalled" shelf. No build step, vanilla JS, dark theme.

export const BROWSE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>auklet 🐦</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, system-ui, sans-serif; background: #0e0f13; color: #e8e8ea; }
  header { position: sticky; top: 0; z-index: 5; display: flex; gap: 14px; align-items: center;
    padding: 12px 18px; background: #14151b; border-bottom: 1px solid #23252e; flex-wrap: wrap; }
  header h1 { font-size: 17px; margin: 0; font-weight: 600; }
  .tabs { display: flex; gap: 4px; }
  .tab { padding: 6px 12px; border-radius: 8px; cursor: pointer; color: #9a9ba4; user-select: none; }
  .tab.on { background: #2a2d3a; color: #fff; }
  input, select { background: #1c1e26; border: 1px solid #2c2f3a; color: #e8e8ea;
    padding: 6px 10px; border-radius: 8px; font-size: 14px; }
  input { flex: 1; min-width: 140px; }
  main { padding: 18px; }
  .muted { color: #8a8b94; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px; }
  .card { background: #16171d; border: 1px solid #21232c; border-radius: 12px; overflow: hidden; }
  .card img, .noart { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; background: #23252e; }
  .noart { display: flex; align-items: center; justify-content: center; font-size: 34px; color: #4a4c58; }
  .card .b { padding: 8px 10px; }
  .card .t { font-size: 13px; font-weight: 600; line-height: 1.3; max-height: 2.6em; overflow: hidden; }
  .card .a { font-size: 12px; color: #9a9ba4; margin-top: 2px; max-height: 1.5em; overflow: hidden; }
  .bar { height: 4px; background: #2a2d3a; border-radius: 3px; margin-top: 8px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: #f7a83e; }
  .pct { font-size: 11px; color: #8a8b94; margin-top: 4px; }
  .done { color: #4ecb71; }
  .day { position: sticky; top: 58px; margin: 20px 0 8px; font-weight: 600; color: #c7c8d0;
    background: #0e0f13; padding: 4px 0; }
  .row { display: flex; gap: 12px; align-items: center; padding: 8px; border-radius: 10px; }
  .row:hover { background: #16171d; }
  .row img, .row .noart { width: 46px; height: 46px; border-radius: 8px; aspect-ratio: auto; }
  .row .meta { flex: 1; min-width: 0; }
  .row .t { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .sub { font-size: 12px; color: #9a9ba4; }
  .row .amt { font-variant-numeric: tabular-nums; color: #f7a83e; font-weight: 600; }
  button.more { margin: 18px auto; display: block; background: #1c1e26; border: 1px solid #2c2f3a;
    color: #e8e8ea; padding: 8px 18px; border-radius: 8px; cursor: pointer; }
</style>
</head>
<body>
<header>
  <h1>auklet 🐦</h1>
  <div class="tabs">
    <div class="tab on" data-view="library">library</div>
    <div class="tab" data-view="history">history</div>
    <div class="tab" data-view="stalled">stalled</div>
  </div>
  <input id="q" placeholder="search title / author…">
  <select id="part" style="display:none">
    <option value="">all day</option>
    <option value="morning">morning</option>
    <option value="afternoon">afternoon</option>
    <option value="evening">evening</option>
    <option value="night">night</option>
  </select>
  <span id="summary" class="muted"></span>
</header>
<main id="main"></main>

<script>
const main = document.getElementById("main")
const qEl = document.getElementById("q")
const partEl = document.getElementById("part")
const summary = document.getElementById("summary")
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

async function loadGrid(stalled) {
  const params = new URLSearchParams({ list: "library", limit: 500 })
  if (qEl.value) params.set("q", qEl.value)
  if (stalled) params.set("stalled", "1")
  const { books } = await fetch("/books?" + params).then(r => r.json())
  summary.textContent = books.length + (stalled ? " stalled (40–80%)" : " books")
  main.className = "grid"
  main.innerHTML = books.map(b => {
    const pct = b.percent_complete != null ? Math.round(b.percent_complete) : null
    const bar = pct != null ? '<div class="bar"><i style="width:'+pct+'%"></i></div>' : ""
    const state = b.is_finished ? '<div class="pct done">finished</div>'
      : pct != null ? '<div class="pct">'+pct+'% · '+hms(b.listened_sec)+' listened</div>' : ""
    return '<div class="card">' + art(b.cover_sha256) +
      '<div class="b"><div class="t">'+ (b.title||"") +'</div><div class="a">'+ authorsOf(b.authors) +'</div>'
      + bar + state + '</div></div>'
  }).join("") || '<p class="muted">nothing here yet — run <code>auklet sync-library</code></p>'
}

async function loadHistory(append) {
  if (!append) { offset = 0; main.innerHTML = ""; main.className = "" }
  const params = new URLSearchParams({ limit: 200, offset })
  if (qEl.value) params.set("q", qEl.value)
  if (partEl.value) params.set("part", partEl.value)
  const { sessions } = await fetch("/sessions?" + params).then(r => r.json())
  summary.textContent = view === "history" ? "listen history" : ""
  let html = ""
  let lastDay = main.dataset.lastDay || ""
  for (const s of sessions) {
    const key = (s.local_time || s.ended_at || "").slice(0,10)
    if (key !== lastDay) { html += '<div class="day">'+ dayLabel(s.local_time || s.ended_at) +'</div>'; lastDay = key }
    const time = (s.local_time || s.started_at || "").slice(11,16)
    html += '<div class="row">'+ art(s.cover_sha256) +
      '<div class="meta"><div class="t">'+ (s.title||"") +'</div>'+
      '<div class="sub">'+ authorsOf(s.authors) +' · '+ time +(s.finished?' · finished':'')+'</div></div>'+
      '<div class="amt">'+ hms(s.listened_sec) +'</div></div>'
  }
  main.dataset.lastDay = lastDay
  main.insertAdjacentHTML("beforeend", html || (append ? "" : '<p class="muted">no listens recorded yet</p>'))
  const old = document.querySelector("button.more"); if (old) old.remove()
  if (sessions.length === 200) {
    const btn = document.createElement("button"); btn.className = "more"; btn.textContent = "load more"
    btn.onclick = () => { offset += 200; loadHistory(true) }
    main.appendChild(btn)
  }
}

function render() {
  partEl.style.display = view === "history" ? "" : "none"
  main.dataset.lastDay = ""
  if (view === "history") loadHistory(false)
  else loadGrid(view === "stalled")
}

document.querySelectorAll(".tab").forEach(tab => tab.onclick = () => {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("on"))
  tab.classList.add("on"); view = tab.dataset.view; render()
})
let debounce
qEl.oninput = () => { clearTimeout(debounce); debounce = setTimeout(render, 250) }
partEl.onchange = render
render()
</script>
</body>
</html>`
