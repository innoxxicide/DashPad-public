// «Ход работ» page served by our Worker.
// The template is the artifact page body (published from the PC as-is). It expects
// window.claude.use("db").collection("chains").onSnapshot(cb); the shim below provides
// that API on top of GET /api/progress, the same idea as PAGE_SHIM in claude_sessions_sync.py.
//
// The mirror merges the «Ход работ» artifacts of every Claude account on the PC, so it also
// carries chains that were abandoned long ago in other accounts' artifacts. Open chains idle
// for longer than settings.progress.staleHours (default 72 h) are therefore kept out of the
// template and listed in one collapsible line under it.

const POLL_MS = 5000;
const SETTINGS_MS = 5 * 60 * 1000;
const PC_SILENT_MS = 15 * 60 * 1000;

function shim(key: string, staleHours: number): string {
  return `<script>
(function () {
  var KEY = ${JSON.stringify(key)}, listeners = [], etag = null, heartbeat = 0, banner = null, lastDocs = null;
  var staleHours = ${Number(staleHours) || 72};
  function auth() { return { Authorization: "Bearer " + KEY }; }
  function note(text) {
    if (!text) { if (banner) { banner.remove(); banner = null; } return; }
    if (!banner) {
      banner = document.createElement("div");
      banner.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:9;padding:8px 12px;border-radius:10px;" +
        "font:600 13px system-ui,sans-serif;background:#c7811a;color:#111;text-align:center";
      (document.body || document.documentElement).appendChild(banner);
    }
    banner.textContent = text;
  }
  function hhmm(ms) { var d = new Date(ms); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
  function plural(n, one, few, many) { var a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; }
  function span(h) { return h % 24 === 0 ? (h / 24) + " " + plural(h / 24, "день", "дні", "днів") : h + " год"; }
  function ago(ms) { var h = Math.round((Date.now() - ms) / 3600000); return h < 48 ? h + " год тому" : Math.round(h / 24) + " " + plural(Math.round(h / 24), "день", "дні", "днів") + " тому"; }
  function check(netError) {
    if (netError) return note("Немає зв'язку з сервером DashPad");
    if (heartbeat && Date.now() - heartbeat > ${PC_SILENT_MS}) return note("ПК не на зв'язку з " + hhmm(heartbeat) + " — дані можуть бути застарілими");
    note(null);
  }
  function renderStale(list) {
    var box = document.getElementById("dp-stale");
    if (!list.length) { if (box) box.remove(); return; }
    if (!box) {
      box = document.createElement("details");
      box.id = "dp-stale";
      box.style.cssText = "max-width:760px;margin:20px auto 0;padding:10px 14px;border:1px solid var(--line,#262b35);border-radius:12px;" +
        "color:var(--muted,#9098a8);font:13px/1.45 var(--body,system-ui),sans-serif";
      var s = document.createElement("summary");
      s.style.cssText = "cursor:pointer";
      box.appendChild(s);
      var ul = document.createElement("div");
      ul.style.cssText = "display:grid;gap:4px;margin-top:8px";
      box.appendChild(ul);
      var host = document.querySelector("main") || document.body;
      host.appendChild(box);
    }
    box.firstChild.textContent = "Без оновлень понад " + span(staleHours) + ": " + list.length;
    var rows = box.lastChild;
    rows.textContent = "";
    list.sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); }).forEach(function (d) {
      var r = document.createElement("div");
      r.textContent = (d.kicker ? d.kicker + " — " : "") + (d.title || "") + " · " + Math.round(d.pct || 0) + "% · " + ago(d.updated);
      rows.appendChild(r);
    });
  }
  function emit(docs) {
    lastDocs = docs;
    var now = Date.now(), cut = staleHours * 3600000, fresh = [], stale = [];
    Object.keys(docs).forEach(function (id) {
      var d = docs[id] || {};
      if ((d.pct || 0) < 100 && d.updated && now - d.updated > cut) stale.push(d);
      else fresh.push({ id: id, exists: true, data: (function (x) { return function () { return x; }; })(d) });
    });
    var snap = { docs: fresh };
    listeners.forEach(function (cb) { try { cb(snap); } catch (e) { console.error(e); } });
    renderStale(stale);
  }
  function poll() {
    var headers = auth();
    if (etag) headers["If-None-Match"] = etag;
    fetch("/api/progress", { headers: headers, cache: "no-store" }).then(function (r) {
      if (r.status === 304) return check(false);
      if (!r.ok) throw new Error("HTTP " + r.status);
      etag = r.headers.get("ETag");
      return r.json().then(function (j) { heartbeat = j.heartbeat || 0; emit(j.docs || {}); check(false); });
    }).catch(function () { check(true); });
  }
  function loadSettings() {
    fetch("/api/settings", { headers: auth(), cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
      var h = s && s.progress && s.progress.staleHours;
      if (h && h !== staleHours) { staleHours = h; if (lastDocs) emit(lastDocs); }
    }).catch(function () {});
  }
  // keep the page header clear of the tablet's ⚙ button (top-right corner of the screen)
  var css = document.createElement("style");
  css.textContent = "header.page{padding-right:44px}";
  document.head.appendChild(css);
  var db = { collection: function () { return { onSnapshot: function (cb) { listeners.push(cb); poll(); } }; } };
  window.claude = { use: function (name) { return Promise.resolve(name === "db" ? db : null); } };
  setInterval(poll, ${POLL_MS});
  setInterval(loadSettings, ${SETTINGS_MS});
  setInterval(function () { if (lastDocs) emit(lastDocs); }, 10 * 60 * 1000); // chains age out without new data
})();
</script>`;
}

const EMPTY = `<main style="font:16px system-ui;padding:32px;color:#888">Шаблон «Ход работ» ще не опубліковано з ПК.</main>`;

export function progressPage(template: string | null, key: string, staleHours = 72): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${shim(key, staleHours)}
</head><body>
${template ?? EMPTY}
</body></html>
`;
}
