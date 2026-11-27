/* Maison Setter command center — core. No framework and no innerHTML: every piece of text from a lead goes
   through textContent, so a hostile bio can never become an element. The security policy forbids inline scripts. */
(() => {
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const NS = "http://www.w3.org/2000/svg";
const _rc = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...k) { return _rc.apply(this, k.flat(Infinity).filter((x) => x != null && x !== false)); };

/* ---------------------------------------------------------------- tiny helpers (shared with views.js via window.MS) */
const ICONS = {
  home: "M3 11.5 12 4l9 7.5M5 10v10h5v-6h4v6h5V10",
  inbox: "M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5a3 3 0 0 0 6 0h5",
  kanban: "M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v13h-4z",
  chat: "M4 5h16v11H9l-5 4z",
  shield: "M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z M9 12l2 2 4-4",
  upload: "M12 16V4m-5 5 5-5 5 5M5 20h14",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0-3a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  users: "M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 20v-2a4 4 0 0 0-3-3.9M16 3.1a3.5 3.5 0 0 1 0 6.8",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  check: "M5 12.5l4.5 4.5L19 7.5", x: "M6 6l12 12M18 6 6 18", plus: "M12 5v14M5 12h14", refresh: "M20 11a8 8 0 0 0-14-4.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14 4.5L20 15M20 20v-5h-5",
  menu: "M4 6h16M4 12h16M4 18h16", out: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5", copy: "M9 9h10v11H9zM5 15V4h10",
  pause: "M8 5v14M16 5v14", play: "M7 5l12 7-12 7z", alert: "M12 3 2 20h20zM12 10v4M12 17v.5", bolt: "M13 3 5 14h6l-1 7 8-11h-6z", bot: "M12 3v3M5 8h14v10H5zM9 13h.01M15 13h.01M3 12v3M21 12v3",
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10.3 21a1.9 1.9 0 0 0 3.4 0",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.35-4.35",
  cal: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  chart: "M3 3v18h18M7 15v3M12 10v8M17 6v12",
  flag: "M4 22V4s1-1 4-1 5 2 8 2 4-1 4-1v11s-1 1-4 1-5-2-8-2-4 1-4 1",
  coin: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 7v10M9.5 9.5c0-1 1-1.7 2.5-1.7s2.5.7 2.5 1.7c0 2.4-5 1.6-5 4.2 0 1 1 1.8 2.5 1.8s2.5-.8 2.5-1.8",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5zM20 17H6.5",
  spark: "M13 2 3 14h7l-1 8 10-12h-7z",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h6"
};
function ico(name) { const s = document.createElementNS(NS, "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "ico"); s.setAttribute("aria-hidden", "true"); const p = document.createElementNS(NS, "path"); p.setAttribute("d", ICONS[name] || ICONS.alert); s.append(p); return s; }
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v; else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else if (k === "text") el.textContent = v;
    else if (k === "value") el.value = v; else if (k === "checked") el.checked = !!v;
    else if (k === "style") { for (const decl of String(v).split(";")) { const i = decl.indexOf(":"); if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); } }
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
const fmt = (n) => (n == null || isNaN(Number(n)) ? "-" : Number(n).toLocaleString("en-US"));
const money = (n) => (n == null || isNaN(Number(n)) ? "-" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const ago = (ms) => { if (!ms) return "never"; const s = Math.round((Date.now() - ms) / 1000); return s < 5 ? "just now" : s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const stamp = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const day = (ms) => new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const initial = (s) => (String(s || "?").replace(/^@/, "")[0] || "?");
const live = (msg) => { const l = $("#live"); l.textContent = ""; setTimeout(() => { l.textContent = msg; }, 50); };
function toast(msg, kind = "") { const t = h("div", { class: "toast " + kind, role: kind === "err" ? "alert" : "status", text: msg }); $("#toasts").append(t); live(msg); setTimeout(() => t.remove(), kind === "err" ? 7000 : 3500); }
const bar = (parts, thick) => { const b = h("div", { class: "bar" + (thick ? " thick" : ""), role: "img", "aria-label": parts.map((p) => `${p.label || ""} ${p.v}`).join(", ") }); const total = parts.reduce((a, p) => a + p.v, 0) || 1; for (const p of parts) { const i = h("i", { class: p.cls || "" }); i.style.width = (p.v / total) * 100 + "%"; b.append(i); } return b; };
const meter = (v, max, cls) => { const b = h("div", { class: "bar", role: "meter", "aria-valuemin": 0, "aria-valuemax": max, "aria-valuenow": v }); const i = h("i", { class: cls || "" }); i.style.width = Math.min(100, max ? (v / max) * 100 : 0) + "%"; b.append(i); return b; };
const badge = (text, cls, dot) => h("span", { class: "badge " + (cls || "") }, dot ? h("span", { class: "dot", "aria-hidden": "true" }) : null, text);
const empty = (title, text, action) => h("div", { class: "empty" }, h("h3", { text: title }), h("p", { text }), action || null);
const field = (id, label, input, hint) => h("div", null, h("label", { for: id, text: label }), input, hint ? h("p", { class: "hint", text: hint }) : null);
const sw = (id, title, sub, checked) => h("label", { class: "switch", for: id }, h("span", { class: "tx" }, h("b", { text: title }), h("span", { text: sub })), h("input", { type: "checkbox", id, checked }));
const scorePill = (s) => (s == null ? null : h("span", { class: "score-pill " + (s >= 75 ? "s-hi" : s >= 50 ? "s-mid" : "s-lo"), "aria-label": `Lead score ${s} of 100`, text: String(s) }));
const delta = (cur, prev) => { if (prev == null || prev === 0) return cur ? h("span", { class: "delta up", text: "new" }) : null; const d = Math.round(((cur - prev) / prev) * 100); if (!d) return h("span", { class: "delta flat", text: "±0%" }); return h("span", { class: "delta " + (d > 0 ? "up" : "down"), text: (d > 0 ? "+" : "") + d + "%" }); };
/* line/area chart as inline SVG (CSP-safe: created through the DOM, no inline styles) */
function sparkline(series, { w = 560, hgt = 120, keys = [], labels } = {}) {
  const NSvg = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NSvg, "svg"); svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`); svg.setAttribute("class", "chart-svg"); svg.setAttribute("role", "img");
  const cols = { revenue: "var(--good)", appointments: "var(--info)", leads: "var(--accent)" };
  const max = Math.max(1, ...series.flatMap((p) => keys.map((k) => p[k] || 0)));
  const pad = 8, stepX = series.length > 1 ? (w - 2 * pad) / (series.length - 1) : 0;
  const linePath = (k) => series.map((p, i) => `${i ? "L" : "M"}${(pad + i * stepX).toFixed(1)},${(hgt - pad - ((p[k] || 0) / max) * (hgt - 2 * pad)).toFixed(1)}`).join(" ");
  for (const k of keys) {
    const p = document.createElementNS(NSvg, "path"); p.setAttribute("d", linePath(k)); p.setAttribute("fill", "none"); p.setAttribute("stroke", cols[k] || "var(--accent)"); p.setAttribute("stroke-width", "2"); p.setAttribute("stroke-linecap", "round"); p.setAttribute("vector-effect", "non-scaling-stroke"); svg.append(p);
    const area = document.createElementNS(NSvg, "path"); area.setAttribute("d", `${linePath(k)} L${(pad + (series.length - 1) * stepX).toFixed(1)},${hgt - pad} L${pad},${hgt - pad} Z`); area.setAttribute("fill", cols[k] || "var(--accent)"); area.setAttribute("opacity", "0.07"); area.setAttribute("stroke", "none"); svg.prepend(area);
  }
  const lbl = document.createElementNS(NSvg, "text"); lbl.setAttribute("x", w / 2); lbl.setAttribute("y", hgt - 1); lbl.setAttribute("text-anchor", "middle"); lbl.setAttribute("font-size", "10"); lbl.setAttribute("fill", "currentColor"); lbl.setAttribute("opacity", "0.55"); lbl.textContent = labels || ""; svg.append(lbl);
  return svg;
}
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  if (r.status === 401 && !path.startsWith("/api/login")) { showLogin(); throw new Error("Please sign in."); }
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  if (!r.ok) throw new Error((j && j.error) || "Something went wrong.");
  return j;
}
const guard = (btn, fn) => async (e) => { e?.preventDefault?.(); const old = btn ? btn.textContent : null; if (btn) btn.disabled = true; try { await fn(); } catch (err) { toast(err.message, "err"); } finally { if (btn) { btn.disabled = false; if (btn.isConnected && old) btn.textContent = old; } } };
async function copyText(text, what = "Copied") { try { await navigator.clipboard.writeText(text); toast(what, "good"); } catch { toast("Could not copy. Select the text and copy it by hand.", "err"); } }
const debounced = (fn, ms = 600) => { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------------------------------------------------------------- pipeline metadata */
const PIPELINE = [
  ["imported", "Imported", "off"], ["enrich_pending", "Enrichment Pending", "off"], ["under_review", "Under Review", "off"], ["qualified", "Qualified", "info"],
  ["ready", "Ready for Outreach", "info"], ["contacted", "Contacted", "info"], ["awaiting_reply", "Awaiting Reply", "off"], ["replied", "Replied", "warn"],
  ["interested", "Interested", "accent"], ["high_intent", "High Intent", "accent"], ["qualified_opportunity", "Qualified Opportunity", "accent"], ["booking_pending", "Booking Pending", "warn"],
  ["booked", "Booked", "good"], ["meeting_completed", "Meeting Completed", "good"], ["proposal", "Proposal / Offer", "warn"], ["won", "Won", "good"],
  ["lost", "Lost", "bad"], ["cold", "Cold", "off"], ["disqualified", "Disqualified", "bad"], ["do_not_contact", "Do Not Contact", "bad"]
];
const PIPE_LABEL = Object.fromEntries(PIPELINE.map(([k, l]) => [k, l]));
const STAGE_META = [["new", "Waiting to send", "off"], ["contacted", "Contacted", "info"], ["replied", "Replied", "warn"], ["interested", "Interested", "accent"], ["booked", "Booked", "good"], ["customer", "Customers", "good"], ["cold", "No response", "off"], ["do_not_contact", "Do not contact", "bad"]];
const STAGE_LABEL = Object.fromEntries(STAGE_META.map(([k, l]) => [k, l]));
const APPT_LABEL = { booking_pending: "Booking Pending", booked: "Booked", confirmed: "Confirmed", rescheduled: "Rescheduled", completed: "Completed", cancelled: "Cancelled", no_show: "No-Show", follow_up_required: "Follow-Up Required", converted: "Converted" };
const APPT_CLS = { booking_pending: "warn", booked: "good", confirmed: "good", rescheduled: "info", completed: "good", cancelled: "bad", no_show: "bad", follow_up_required: "warn", converted: "good" };
const INTENT_LABEL = { interested: "Interested", question: "Question", not_interested: "Not interested", stop: "Asked to stop", booked: "Ready to book", neutral: "Neutral" };

/* ---------------------------------------------------------------- shared namespace for the view files */
const MS = window.MS = { ICONS, ico, h, fmt, money, pct, ago, clock, stamp, day, initial, toast, live, bar, meter, badge, empty, field, sw, scorePill, delta, sparkline, api, guard, copyText, debounced,
  PIPELINE, PIPE_LABEL, STAGE_META, STAGE_LABEL, APPT_LABEL, APPT_CLS, INTENT_LABEL, VIEWS: {}, S: null };

/* ---------------------------------------------------------------- state */
const S = MS.S = { clients: [], clientId: "", days: 7, view: null, nav: 0, counts: { review: 0, replies: 0, held: 0, alerts: 0, unread: 0 }, liveAt: 0, es: null, accountsAlert: 0 };
const q = () => `days=${S.days}${S.clientId ? "&clientId=" + S.clientId : ""}`;
const clientName = (id) => (S.clients.find((c) => c.id === id) || {}).name || "";
const campaignOptions = (sel, withAll) => [withAll ? h("option", { value: "", text: "All campaigns" }) : null, ...S.clients.map((c) => h("option", { value: c.id, text: c.name, selected: String(c.id) === String(sel) ? true : null }))];

/* ---------------------------------------------------------------- preferences (stored in this browser) */
function loadPrefs() { try { return JSON.parse(localStorage.getItem("me_prefs") || "{}"); } catch { return {}; } }
function applyPrefs(p) { document.documentElement.dataset.theme = p.theme || "auto"; document.documentElement.dataset.size = p.size || "m"; document.documentElement.dataset.contrast = p.contrast ? "on" : "off"; $("#theme").value = p.theme || "auto"; $("#size").value = p.size || "m"; $("#contrast").checked = !!p.contrast; }
function savePrefs() { const p = { theme: $("#theme").value, size: $("#size").value, contrast: $("#contrast").checked }; try { localStorage.setItem("me_prefs", JSON.stringify(p)); } catch { /* private mode */ } applyPrefs(p); }

/* ---------------------------------------------------------------- real-time link */
function setLive(state) { const pill = $("#livePill"); pill.className = "live-pill" + (state === "on" ? "" : state === "wait" ? " off" : " down"); $("#liveText").textContent = state === "on" ? "Live" : state === "wait" ? "Reconnecting…" : "Offline"; }
function connectStream() {
  if (S.es) S.es.close();
  const es = new EventSource("/api/stream"); S.es = es; setLive("wait");
  es.onopen = () => { S.liveAt = Date.now(); setLive("on"); };
  es.onmessage = (m) => { S.liveAt = Date.now(); setLive("on"); let e; try { e = JSON.parse(m.data); } catch { return; } if (e.t !== "ping" && e.t !== "hello") onEvent(e); };
  es.onerror = () => setLive("wait");
}
setInterval(() => { if (S.es && S.liveAt && Date.now() - S.liveAt > 55_000) { setLive("wait"); connectStream(); } }, 15_000);
let countsTimer = null;
function onEvent(e) {
  if (e.t === "activity") feedPush(e);
  if (e.t === "notification") refreshCounts();
  if (S.view && S.view.onEvent) S.view.onEvent(e);
  if (["lead", "task", "campaign", "account", "appointment"].includes(e.t)) { clearTimeout(countsTimer); countsTimer = setTimeout(refreshCounts, 700); }
}
async function refreshCounts() {
  try {
    const d = await api("GET", `/api/overview?${q()}`);
    const p = await api("GET", "/api/notifications?unread=1").catch(() => ({ unread: 0 }));
    S.counts = { review: d.digest.pendingReview, replies: d.digest.repliesWaiting, held: d.supervisor ? d.supervisor.waiting : 0, unread: p.unread || 0 };
    S.accountsAlert = d.alerts.filter((a) => a.level === "bad").length;
    drawNav(); drawBellCount();
  } catch { /* signed out */ }
}

/* ---------------------------------------------------------------- navigation */
const NAV = [
  { sep: "Command Center" },
  { id: "overview", label: "Overview", icon: "home" },
  { id: "inbox", label: "Inbox", icon: "inbox", badge: () => S.counts.replies },
  { id: "leads", label: "Leads", icon: "users" },
  { id: "pipeline", label: "Pipeline", icon: "kanban" },
  { id: "appointments", label: "Appointments", icon: "cal" },
  { id: "campaigns", label: "Campaigns", icon: "target" },
  { id: "opportunities", label: "Opportunities", icon: "flag", badge: () => S.counts.alerts },
  { id: "analytics", label: "Analytics & ROI", icon: "chart" },
  { id: "reports", label: "Reports", icon: "file" },
  { sep: "Operations" },
  { id: "review", label: "Review", icon: "check", badge: () => S.counts.review },
  { id: "import", label: "Import leads", icon: "upload" },
  { id: "quality", label: "Lead quality", icon: "shield" },
  { id: "accounts", label: "Sender accounts", icon: "user", badge: () => S.accountsAlert, warn: true },
  { id: "live", label: "Senders live", icon: "bolt" },
  { id: "test", label: "Sender test", icon: "spark" },
  { id: "diary", label: "Day diary", icon: "file" },
  { id: "warmup", label: "Warm-up", icon: "cal" },
  { id: "runner", label: "Runner (VPS)", icon: "bolt" },
  { id: "supervisor", label: "AI supervisor", icon: "bot", badge: () => S.counts.held },
  { id: "lab", label: "AI Lab", icon: "chat" },
  { sep: "Workspace" },
  { id: "onboarding", label: "Onboarding", icon: "spark" },
  { id: "builder", label: "AI builder", icon: "bot" },
  { id: "profile", label: "Business profile", icon: "book" },
  { id: "knowledge", label: "Knowledge & script", icon: "file" },
  { id: "settings", label: "Settings", icon: "gear" }
];
const routeId = () => (location.hash.replace(/^#\/?/, "").split("?")[0] || "overview");
function drawNav() {
  const cur = routeId(), ul = $("#nav"); ul.replaceChildren();
  for (const r of NAV) {
    if (r.sep) { ul.append(h("li", { class: "sep", "aria-hidden": "true", text: r.sep })); continue; }
    const n = r.badge ? r.badge() : 0;
    ul.append(h("li", null, h("a", { href: "#/" + r.id, "aria-current": r.id === cur ? "page" : null }, ico(r.icon), h("span", { text: r.label }), n ? h("span", { class: "count" + (r.warn ? " warn" : ""), "aria-label": `${n} waiting`, text: String(n) }) : null)));
  }
}
function closeMenu() { $("#side").classList.remove("open"); $("#scrim").hidden = true; $("#menu").setAttribute("aria-expanded", "false"); }
async function go(first) {
  const id = routeId(), view = MS.VIEWS[id] || MS.VIEWS.overview;
  const token = ++S.nav, main = $("#main");
  if (S.view && typeof S.view.unmount === "function") S.view.unmount();   // stop page timers (Senders Live polling) before leaving
  S.view = null; closeMenu(); closeDrawer(); drawNav(); closePops();
  const title = (NAV.find((r) => r.id === id) || NAV.find((r) => r.id === "overview")).label;
  $("#pageTitle").textContent = title; document.title = title + " · Maison Setter"; $("#pageSub").textContent = "";
  const hideFilters = ["accounts", "live", "test", "diary", "warmup", "settings", "import", "campaigns", "runner", "onboarding", "profile", "lab", "builder", "knowledge"].includes(id);
  $("#filters").hidden = hideFilters;
  main.replaceChildren(h("p", { class: "muted", text: "Loading…" }));
  try {
    const frag = h("div"); const v = await view(frag);
    if (token !== S.nav) return;
    main.replaceChildren(...frag.childNodes); S.view = v || {};
    if (S.view.mounted) S.view.mounted();
  } catch (e) { if (token === S.nav) main.replaceChildren(empty("This page could not load", e.message, h("button", { class: "btn primary", type: "button", onclick: () => go(), text: "Try again" }))); }
  if (!first) $("#pageTitle").focus();
}

/* ---------------------------------------------------------------- global search + notifications */
let searchCtl = null;
function wireSearch() {
  const input = $("#globalSearch"), pop = $("#searchPop");
  input.addEventListener("input", () => {
    clearTimeout(searchCtl);
    const term = input.value.trim();
    if (!term) { pop.hidden = true; return; }
    searchCtl = setTimeout(async () => {
      try {
        const r = await api("GET", "/api/search?q=" + encodeURIComponent(term));
        pop.replaceChildren(...r.results.map((x) => h("button", { class: "sr-item", type: "button", onclick: () => { pop.hidden = true; input.value = ""; if (x.leadId) MS.openLeadId = x.leadId; location.hash = x.to; } },
          h("span", { class: "kind", text: x.type }), h("b", { text: x.title }), h("span", { class: "sr-sub", text: x.sub || "" }))),
          r.results.length ? null : h("p", { class: "muted small", style: "padding:.6rem", text: "Nothing found." }));
        pop.hidden = false;
      } catch { pop.hidden = true; }
    }, 260);
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { pop.hidden = true; input.blur(); } });
  document.addEventListener("click", (e) => { if (!e.target.closest(".search-wrap") || e.target === input) return; if (!e.target.closest(".search-pop") && e.target.id !== "globalSearch") pop.hidden = true; });
}
function drawBellCount() {
  const b = $("#bellBtn"); b.replaceChildren(ico("bell"));
  if (S.counts.unread) b.append(h("span", { class: "bubble", text: String(S.counts.unread) }));
}
function closePops() { $("#searchPop").hidden = true; $("#notifPop").hidden = true; $("#bellBtn").setAttribute("aria-expanded", "false"); }
async function toggleNotif() {
  const pop = $("#notifPop"), open = pop.hidden;
  closePops(); if (!open) return;
  $("#bellBtn").setAttribute("aria-expanded", "true");
  pop.hidden = false; pop.replaceChildren(h("p", { class: "muted small", style: "padding:.8rem", text: "Loading…" }));
  try {
    const r = await api("GET", "/api/notifications");
    const head = h("header", null, h("span", { text: "Notifications" }));
    head.append(r.unread ? h("button", { class: "btn sm ghost", type: "button", text: "Mark all read", onclick: async () => { await api("POST", "/api/notifications/read", { all: true }).catch(() => {}); drawBellCount(); toggleNotif(); } }) : h("span", { class: "muted small", text: "All caught up" }));
    const items = r.notifications.slice(0, 30).map((n) => {
      const el = h("div", { class: "notif-item " + (n.read ? "read" : "unread") }, h("span", { class: "nd", "aria-hidden": "true" }));
      const tx = h("div", { class: "grow" }, h("b", { text: n.title }), h("div", { class: "small muted", text: n.body || "" }), h("time", { text: ago(n.created_at) }));
      if (n.lead_id) tx.append(h("div", null, h("button", { class: "btn sm ghost", type: "button", text: "Open lead", onclick: () => { pop.hidden = true; MS.openLeadId = n.lead_id; location.hash = "#/leads"; } })));
      el.append(tx); return el;
    });
    pop.replaceChildren(head, items.length ? items : h("p", { class: "muted small", style: "padding:.8rem", text: "Nothing yet. Important opportunities and actions appear here." }));
  } catch (e) { pop.replaceChildren(h("p", { class: "muted small", style: "padding:.8rem", text: e.message })); }
}

/* ---------------------------------------------------------------- drawer */
let drawerFrom = null;
function openDrawer(title, body) {
  const wrap = $("#drawerWrap"), d = $("#drawer"); drawerFrom = document.activeElement;
  const close = h("button", { class: "icon-btn", type: "button", "aria-label": "Close", onclick: closeDrawer }, ico("x"));
  d.replaceChildren(h("header", null, h("h2", { id: "drawerTitle", class: "grow", text: title }), close), h("div", { class: "body" }, body)); wrap.hidden = false; close.focus();
}
function closeDrawer() { const wrap = $("#drawerWrap"); if (wrap.hidden) return; wrap.hidden = true; $("#drawer").replaceChildren(); if (drawerFrom && drawerFrom.isConnected) drawerFrom.focus(); }
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeDrawer(); closeMenu(); closePops(); return; }
  if (e.key === "Tab" && !$("#drawerWrap").hidden) { const f = [...$("#drawer").querySelectorAll("a[href],button:not(:disabled),input:not(:disabled),select,textarea")].filter((x) => x.offsetParent !== null); if (!f.length) return; const first = f[0], last = f[f.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
});
$("#drawerScrim").addEventListener("click", closeDrawer);

/* ---------------------------------------------------------------- shared feed */
function feedItem(a) { return h("li", null, h("span", { class: "t num", text: clock(a.at) }), h("span", { class: "lv " + (a.level || ""), "aria-hidden": "true" }), h("span", { class: "grow", text: a.text })); }
function feedPush(a) {
  for (const ul of document.querySelectorAll("[data-feed]")) {
    const li = feedItem(a); li.classList.add("fresh"); ul.prepend(li);
    while (ul.children.length > 40) ul.lastChild.remove();
    const e = ul.querySelector(".empty-li"); if (e) e.remove();
  }
}
const feedList = (rows) => { const ul = h("ul", { class: "feed", "data-feed": "1", "aria-label": "Live activity" }); if (!rows.length) ul.append(h("li", { class: "empty-li" }, h("span", { class: "muted", text: "Nothing yet. Activity from your senders and the lead checker shows up here live." }))); for (const a of rows) ul.append(feedItem(a)); return ul; };
function stateBadge(a) { return a.badge === "quarantined" ? badge("Quarantined", "bad", true) : a.badge === "warming" ? badge("Warming up", "warn", true) : a.badge === "active" ? badge("Active", "good", true) : a.badge === "paused" ? badge("Paused", "") : badge("Off", ""); }
function kpi(label, value, sub, o = {}) { const el = h(o.href ? "a" : "div", { class: "card kpi " + (o.cls || ""), href: o.href }, h("span", { class: "label" }, o.icon ? ico(o.icon) : null, label), h("span", { class: "value", text: typeof value === "string" ? value : fmt(value) }), h("span", { class: "sub", text: sub || "" })); if (o.delta) el.append(o.delta); return el; }
function stageBars(funnel) {
  const total = Object.values(funnel).reduce((a, b) => a + b, 0);
  if (!total) return empty("No approved leads yet", "Approve leads in Review and they appear here.");
  return h("div", { class: "stack" }, STAGE_META.filter(([k]) => funnel[k]).map(([k, label, cls]) => h("div", null, h("div", { class: "row between small" }, h("span", { text: label }), h("b", { class: "num", text: fmt(funnel[k]) })), meter(funnel[k], total, cls === "accent" ? "" : cls))));
}
function miniAccount(a) {
  const cap = a.capToday || 0;
  return h("div", null, h("div", { class: "row between" }, h("span", null, h("b", { text: a.label }), " ", h("span", { class: "muted small", text: "@" + a.igUsername })), stateBadge(a)),
    h("div", { class: "row between small muted" }, h("span", { class: "num", text: `${a.sentToday} / ${cap} sent today` }), h("span", { class: "online" + (a.online ? " on" : ""), "aria-label": a.online ? "Browser connected" : "Browser not connected" }, h("i"), a.online ? "Connected" : a.lastSeenAt ? ago(a.lastSeenAt) : "Never connected")),
    meter(a.sentToday, Math.max(cap, 1), a.badge === "quarantined" ? "bad" : ""));
}
MS.stateBadge = stateBadge; MS.miniAccount = miniAccount; MS.feedList = feedList; MS.feedPush = feedPush; MS.stageBars = stageBars; MS.kpi = kpi; MS.campaignOptions = campaignOptions; MS.clientName = clientName; MS.q = q; MS.openDrawer = openDrawer; MS.closeDrawer = closeDrawer; MS.refreshCounts = refreshCounts; MS.drawNav = drawNav;

/* ---------------------------------------------------------------- login and start-up */
function showLogin(setup) {
  if (S.es) { S.es.close(); S.es = null; } $("#app").hidden = true; $("#login").hidden = false;
  if (setup) { const m = $("#loginMsg"); m.className = "msg err"; m.textContent = "Set the ADMIN_PASSWORD environment variable on the server, restart it, then sign in."; }
  $("#pw").focus();
}
async function start() {
  $("#login").hidden = true; $("#app").hidden = false; $("#menu").replaceChildren(ico("menu")); $("#bellBtn").replaceChildren(ico("bell"));
  await reloadClients().catch(() => {}); connectStream(); refreshCounts(); await go(true);
}
async function reloadClients() { S.clients = (await api("GET", "/api/clients")).clients; $("#fClient").replaceChildren(...campaignOptions(S.clientId, true)); }
$("#loginForm").addEventListener("submit", async (e) => { e.preventDefault(); const m = $("#loginMsg"); m.textContent = ""; m.className = "msg"; try { await api("POST", "/api/login", { password: $("#pw").value }); $("#pw").value = ""; await start(); } catch (err) { m.className = "msg err"; m.textContent = err.message; } });
$("#logout").addEventListener("click", async () => { await api("POST", "/api/logout", {}).catch(() => {}); location.hash = ""; showLogin(); });
for (const id of ["theme", "size", "contrast"]) $("#" + id).addEventListener("change", savePrefs);
$("#fClient").addEventListener("change", (e) => { S.clientId = e.target.value; refreshCounts(); go(); });
$("#fDays").addEventListener("change", (e) => { S.days = Number(e.target.value); go(); });
$("#menu").addEventListener("click", () => { const open = $("#side").classList.toggle("open"); $("#scrim").hidden = !open; $("#menu").setAttribute("aria-expanded", String(open)); });
$("#scrim").addEventListener("click", closeMenu);
$("#bellBtn").addEventListener("click", toggleNotif);
document.addEventListener("click", (e) => { if (!e.target.closest(".search-wrap")) closePops(); });
window.addEventListener("hashchange", () => go());
wireSearch();
applyPrefs(loadPrefs());
api("GET", "/api/session").then((s) => {
  const sv = s.version ? "v" + s.version : "unknown";
  const a = $("#serverVersion"); if (a) a.textContent = sv;          // login card: the REAL deployed version, from the server
  const b = $("#brandVersion"); if (b) b.textContent = sv;           // sidebar
  return s.authed ? start() : showLogin(s.setupNeeded);
}).catch(() => { const a = $("#serverVersion"); if (a) a.textContent = "unreachable"; showLogin(); });
})();
