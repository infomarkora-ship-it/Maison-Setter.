/**
 * DM Setter dashboard v3: an 8-page single-file app served at GET /dashboard.
 * Pages: Home, Pipeline, Conversations, Comments, Clients, AI Studio, Ask AI, Health & help.
 *
 * Accessibility: semantic landmarks, skip link, labelled controls, real buttons (everything
 * reachable by Tab), focus moved into dialogs, Escape closes them, status changes announced via
 * aria-live, high-contrast light/dark themes plus a manual toggle, forced-colors support.
 * All dynamic content is inserted with textContent (never innerHTML), so lead messages cannot
 * inject markup or script. The admin token lives in sessionStorage only and is sent as a Bearer
 * header to /api/*.
 *
 * NOTE: the JS below is deliberately written without backticks or template literals — this whole
 * page is one TypeScript template literal, and String.raw would pass escape characters through.
 */
export function dashboardHtml(): string {
  return PAGE;
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>DM Setter</title>
<style>
  @font-face {
    font-family: 'Plus Jakarta Sans';
    font-style: normal;
    font-weight: 200 800;
    font-display: swap;
    src: url(/assets/plus-jakarta-sans-latin.woff2) format('woff2');
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
  @font-face {
    font-family: 'Plus Jakarta Sans';
    font-style: normal;
    font-weight: 200 800;
    font-display: swap;
    src: url(/assets/plus-jakarta-sans-latin-ext.woff2) format('woff2');
    unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
  }

  :root {
    color-scheme: light dark;
    --bg: #f6f6f3; --surface: #ffffff; --fg: #171d1a; --muted: #5c6660; --line: #e2e6e1; --line-strong: #c4ccc6;
    --accent: #0e7a55; --accent-hover: #0b5f43; --accent-fg: #ffffff; --accent-soft: #e8f3ee; --accent-line: #9ccab6;
    --ok: #156d43; --ok-soft: #e6f2ec; --bad: #a92e21; --bad-soft: #faece9; --warn: #8a6200; --warn-soft: #faf3dd;
    --bubble-in: #eef1ee; --shadow: 0 1px 2px rgba(20, 30, 25, 0.06), 0 4px 14px rgba(20, 30, 25, 0.05);
    --radius: 12px; --sidebar-w: 236px;
  }
  :root[data-theme='dark'] {
    --bg: #101311; --surface: #181d1a; --fg: #eef1ef; --muted: #a5b0aa; --line: #2a322d; --line-strong: #46504a;
    --accent: #46bd8c; --accent-hover: #63d0a2; --accent-fg: #06251a; --accent-soft: #1d2b25; --accent-line: #2f5c48;
    --ok: #6fd39f; --ok-soft: #1c2d24; --bad: #f08e80; --bad-soft: #331f1c; --warn: #e2b64f; --warn-soft: #2e2716;
    --bubble-in: #212823; --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 6px 18px rgba(0, 0, 0, 0.35);
  }

  * { box-sizing: border-box; }
  html { height: 100%; }
  body {
    margin: 0; min-height: 100%; background: var(--bg); color: var(--fg);
    font: 16px/1.55 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a, button, input, select, textarea { font: inherit; color: inherit; }
  h1 { font-size: 1.55rem; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 4px; }
  h2 { font-size: 1.17rem; font-weight: 600; margin: 0 0 4px; }
  h3 { font-size: 1rem; font-weight: 600; margin: 18px 0 6px; }
  p { margin: 6px 0; }

  .skip { position: absolute; left: -9999px; top: 0; background: var(--accent); color: var(--accent-fg); padding: 10px 16px; border-radius: 0 0 8px 0; z-index: 60; font-weight: 600; }
  .skip:focus { left: 0; top: 0; }
  :focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

  .shell { display: flex; min-height: 100vh; }

  /* ---------- sidebar ---------- */
  .sidebar {
    width: var(--sidebar-w); flex-shrink: 0; background: var(--surface); border-right: 1px solid var(--line);
    display: flex; flex-direction: column; gap: 18px; padding: 20px 14px; position: sticky; top: 0; height: 100vh;
  }
  .brand { font-weight: 700; font-size: 1.05rem; letter-spacing: -0.01em; padding: 0 10px; }
  .brand small { display: block; font-weight: 500; color: var(--muted); font-size: 0.78rem; margin-top: 2px; }
  .side-nav { display: flex; flex-direction: column; gap: 2px; }
  .side-nav a {
    display: flex; align-items: center; gap: 10px; padding: 11px 12px; border-radius: 10px;
    color: var(--fg); font-weight: 500; min-height: 44px;
  }
  .side-nav a:hover { background: var(--accent-soft); text-decoration: none; }
  .side-nav a[aria-current='page'] { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
  .side-nav .dot { width: 18px; text-align: center; color: var(--muted); flex-shrink: 0; font-size: 0.95rem; }
  .side-nav a[aria-current='page'] .dot { color: var(--accent); }
  .side-nav .navbadge { margin-left: auto; background: var(--bad); color: var(--accent-fg); border-radius: 99px; font-size: 0.72rem; font-weight: 600; padding: 1px 8px; }
  .clientbox { border-top: 1px solid var(--line); padding-top: 14px; }
  .sidefoot { margin-top: auto; display: flex; flex-direction: column; gap: 6px; }

  .content { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .mobilebar { display: none; }
  main { padding: 28px 34px 80px; max-width: 1160px; width: 100%; margin: 0 auto; }
  main:focus { outline: none; }

  /* ---------- primitives ---------- */
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px 20px; box-shadow: var(--shadow); }
  .card + .card { margin-top: 16px; }
  .card h2 { margin-bottom: 2px; }
  .sub { color: var(--muted); font-size: 0.9rem; margin: 0 0 12px; }
  .hint { color: var(--muted); font-size: 0.85rem; margin: 4px 0 0; line-height: 1.45; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .spread { justify-content: space-between; }
  .stack { display: flex; flex-direction: column; gap: 12px; }

  .metrics { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin: 0 0 16px; }
  .metric { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; box-shadow: var(--shadow); }
  .metric dt { color: var(--muted); font-size: 0.82rem; font-weight: 500; }
  .metric dd { margin: 4px 0 0; font-size: 1.45rem; font-weight: 600; letter-spacing: -0.02em; }
  .metric small { color: var(--muted); font-size: 0.78rem; font-weight: 500; }

  button {
    min-height: 44px; padding: 9px 16px; border-radius: 10px; border: 1px solid transparent;
    background: var(--accent); color: var(--accent-fg); font-weight: 600; cursor: pointer;
  }
  button:hover { background: var(--accent-hover); }
  button.secondary { background: var(--surface); color: var(--fg); border-color: var(--line-strong); }
  button.secondary:hover { background: var(--accent-soft); }
  button.danger { background: var(--bad-soft); color: var(--bad); border-color: var(--bad); }
  button.small { min-height: 36px; padding: 5px 12px; font-size: 0.88rem; }
  button:disabled { opacity: 0.55; cursor: not-allowed; }
  button.linkbtn { background: none; border: none; color: var(--accent); font-weight: 600; padding: 6px 8px; min-height: 40px; }
  button.linkbtn:hover { text-decoration: underline; background: none; }

  label { display: block; font-weight: 600; font-size: 0.92rem; margin: 12px 0 4px; }
  input, select, textarea {
    width: 100%; padding: 9px 12px; border: 1px solid var(--line-strong); border-radius: 9px;
    background: var(--bg); color: var(--fg); min-height: 44px;
  }
  textarea { min-height: 84px; resize: vertical; }
  .field { max-width: 34rem; }
  .grid2 { display: grid; gap: 0 22px; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }

  .tag { display: inline-flex; align-items: center; border: 1px solid var(--line-strong); border-radius: 99px; padding: 2px 10px; font-size: 0.78rem; font-weight: 600; color: var(--muted); white-space: nowrap; }
  .tag.accent { background: var(--accent-soft); color: var(--accent); border-color: var(--accent-line); }
  .tag.ok { background: var(--ok-soft); color: var(--ok); border-color: var(--ok); }
  .tag.bad { background: var(--bad-soft); color: var(--bad); border-color: var(--bad); }
  .tag.warn { background: var(--warn-soft); color: var(--warn); border-color: var(--warn); }

  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 640px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 0.82rem; color: var(--muted); font-weight: 600; }
  caption { text-align: left; color: var(--muted); font-size: 0.88rem; padding: 0 0 8px; }

  #status { min-height: 1.4em; font-weight: 500; font-size: 0.92rem; margin: 0 0 14px; }
  #status.good { color: var(--ok); } #status.err { color: var(--bad); }

  /* ---------- chat ---------- */
  .chatwrap { display: grid; grid-template-columns: 300px minmax(0, 1fr) 300px; gap: 16px; align-items: start; }
  .convlist { display: flex; flex-direction: column; }
  .convrow { display: block; width: 100%; text-align: left; background: var(--surface); border: 1px solid var(--line); border-bottom: none; border-radius: 0; padding: 12px 14px; min-height: 44px; cursor: pointer; font-weight: 400; color: var(--fg); }
  .convrow:hover { background: var(--accent-soft); }
  .convrow:first-child { border-radius: 12px 12px 0 0; }
  .convrow:last-child { border-bottom: 1px solid var(--line); border-radius: 0 0 12px 12px; }
  .convrow:only-child { border-radius: 12px; }
  .convrow[aria-current='true'] { background: var(--accent-soft); }
  .convrow .who { font-weight: 600; }
  .convrow .prev { color: var(--muted); font-size: 0.85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .msgs { display: flex; flex-direction: column; gap: 8px; padding: 6px 2px; }
  .msg { max-width: 78%; padding: 9px 14px; border-radius: 16px; background: var(--bubble-in); }
  .msg.out { align-self: flex-end; background: var(--accent); color: var(--accent-fg); }
  .msg .meta { font-size: 0.74rem; opacity: 0.75; margin-top: 3px; }
  .msg.in { align-self: flex-start; }
  .dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 0.9rem; margin: 8px 0; }
  .dl dt { color: var(--muted); font-weight: 500; }
  .dl dd { margin: 0; }

  /* ---------- pipeline ---------- */
  .pipe { display: grid; grid-template-columns: repeat(5, minmax(180px, 1fr)); gap: 12px; overflow-x: auto; padding-bottom: 8px; }
  .pcol { background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px; min-width: 180px; }
  .pcol h3 { margin: 2px 4px 10px; font-size: 0.9rem; display: flex; gap: 8px; align-items: center; }
  .pcol .count { color: var(--muted); font-weight: 500; }
  .leadcard { display: block; width: 100%; text-align: left; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 0 0 10px; cursor: pointer; font-weight: 400; min-height: 44px; box-shadow: var(--shadow); color: var(--fg); }
  .leadcard:hover { border-color: var(--accent-line); background: var(--accent-soft); }
  .leadcard .who { font-weight: 600; }
  .leadcard .prev { color: var(--muted); font-size: 0.85rem; margin-top: 3px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

  /* ---------- needs-you list ---------- */
  .needlist { list-style: none; margin: 0; padding: 0; }
  .needlist li { display: flex; gap: 12px; align-items: flex-start; padding: 12px 4px; border-bottom: 1px solid var(--line); }
  .needlist li:last-child { border-bottom: none; }
  .needlist .what { flex: 1; min-width: 0; }
  .needlist .what b { font-weight: 600; }
  .needlist .what .detail { color: var(--muted); font-size: 0.88rem; }

  /* ---------- modal ---------- */
  .overlay { position: fixed; inset: 0; background: rgba(10, 14, 12, 0.55); display: flex; align-items: flex-start; justify-content: center; padding: 4vh 16px; z-index: 50; }
  .modal { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; width: min(880px, 100%); max-height: 92vh; overflow-y: auto; padding: 20px 22px; box-shadow: var(--shadow); }

  /* ---------- ask ai ---------- */
  .aichat { display: flex; flex-direction: column; gap: 14px; max-width: 46rem; }
  .ai-msg { border-radius: 14px; padding: 12px 16px; white-space: pre-wrap; }
  .ai-msg.user { background: var(--accent-soft); align-self: flex-end; max-width: 85%; }
  .ai-msg.bot { background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow); }
  .sourcechips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .propbox { border: 1px solid var(--warn); background: var(--warn-soft); border-radius: 10px; padding: 12px 14px; margin-top: 10px; }
  .chip { border: 1px solid var(--accent-line); background: var(--accent-soft); color: var(--accent); border-radius: 99px; padding: 3px 12px; font-size: 0.82rem; font-weight: 600; cursor: pointer; min-height: 32px; }

  .bar { background: var(--bg); border: 1px solid var(--line-strong); border-radius: 99px; height: 12px; overflow: hidden; max-width: 26rem; }
  .bar span { display: block; height: 100%; background: var(--accent); }
  .bar.warnbar span { background: var(--warn); }

  .empty { color: var(--muted); padding: 18px 6px; }
  .mono { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 0.84rem; word-break: break-all; }
  .divider { border: none; border-top: 1px solid var(--line); margin: 18px 0; }
  .right { margin-left: auto; }
  [hidden] { display: none !important; }

  @media (max-width: 900px) {
    .sidebar { position: fixed; z-index: 40; transform: translateX(-100%); transition: transform 0.2s ease; width: 262px; }
    .sidebar.open { transform: translateX(0); }
    .mobilebar {
      display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--surface);
      border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 30;
    }
    .mobilebar .title { font-weight: 600; }
    main { padding: 20px 16px 70px; }
    .chatwrap { grid-template-columns: 1fr; }
    .pipe { grid-template-columns: repeat(5, minmax(200px, 1fr)); }
  }
  @media (min-width: 901px) { .mobilebar { display: none; } .scrim { display: none !important; } }
  .scrim { position: fixed; inset: 0; background: rgba(10, 14, 12, 0.5); z-index: 35; }

  @media (forced-colors: active) {
    button, input, select, textarea, .card, .metric, .leadcard, .convrow { border: 1px solid CanvasText; }
    .msg { border: 1px solid CanvasText; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; scroll-behavior: auto !important; } }
</style>
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<div class="shell">
  <aside class="sidebar" id="sidebar" aria-label="Main navigation">
    <p class="brand">DM Setter<small>Your Instagram assistant</small></p>
    <nav class="side-nav" aria-label="Pages">
      <a href="#home" data-nav="home"><span class="dot" aria-hidden="true">⌂</span>Home</a>
      <a href="#pipeline" data-nav="pipeline"><span class="dot" aria-hidden="true">≣</span>Pipeline</a>
      <a href="#conversations" data-nav="conversations"><span class="dot" aria-hidden="true">✉</span>Conversations</a>
      <a href="#comments" data-nav="comments"><span class="dot" aria-hidden="true">❑</span>Comments</a>
      <a href="#clients" data-nav="clients"><span class="dot" aria-hidden="true">◔</span>Clients</a>
      <a href="#studio" data-nav="studio"><span class="dot" aria-hidden="true">✎</span>AI Studio</a>
      <a href="#ask" data-nav="ask"><span class="dot" aria-hidden="true">◈</span>Ask AI</a>
      <a href="#health" data-nav="health"><span class="dot" aria-hidden="true">♥</span>Health &amp; help</a>
    </nav>
    <div class="clientbox" id="clientbox" hidden>
      <label for="client-select">Business</label>
      <select id="client-select"></select>
      <p class="hint">Everything in the pages is about this business.</p>
    </div>
    <div class="sidefoot">
      <button type="button" id="theme-toggle" class="secondary" aria-label="Switch between light and dark look">Toggle light / dark</button>
      <button type="button" id="logout" class="secondary">Log out</button>
    </div>
  </aside>
  <div class="scrim" id="scrim" hidden></div>
  <div class="content">
    <div class="mobilebar">
      <button type="button" id="menu-btn" class="secondary small" aria-expanded="false" aria-controls="sidebar">Menu</button>
      <span class="title" id="mob-title">DM Setter</span>
      <span id="mob-count" class="right tag bad" hidden></span>
    </div>
    <main id="main" tabindex="-1">
      <p id="status" role="status" aria-live="polite"></p>
      <div id="page"></div>
    </main>
  </div>
</div>
<div id="modal-root"></div>
<script>
// __JS_PART_1__
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  // Storage can throw in browsers that block site data (strict privacy settings, some webviews).
  // Never let that kill the whole app — degrade to "not logged in".
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* token just won't persist */ } }
  function ssDel(k) { try { sessionStorage.removeItem(k); } catch (e) { /* already gone */ } }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* preference just won't persist */ } }

  var state = {
    token: ssGet('dms_token') || '',
    clients: [],
    clientId: lsGet('dms_client') || '',
    modes: [],
    askHistory: [],
    lastNeedCount: null,
  };

  var CALLS = ['no_booking_link_sent', 'booking_link_sent', 'call_booked', 'call_rescheduled', 'call_canceled', 'call_completed', 'call_no_show'];
  var CALL_LABELS = {
    no_booking_link_sent: 'No booking link sent yet', booking_link_sent: 'Booking link sent',
    call_booked: 'Call booked', call_rescheduled: 'Call rescheduled', call_canceled: 'Call cancelled',
    call_completed: 'Call completed', call_no_show: 'Missed the call (no-show)',
  };
  var GOAL_LABELS = {
    qualify_fit: 'find out whether they fit', clarify_objection: 'clear up their hesitation',
    confirm_preferred_slot: 'agree on a day and time', get_booking_completed: 'get the booking finished',
    recover_no_show: 'rebook after a missed call', rebook_canceled: 'rebook after a cancellation',
  };
  var STATE_LABELS = {
    new: 'New', qualifying: 'Talking', qualified: 'Qualified', objection: 'Talking (has doubts)', scheduling: 'Talking (picking a time)',
    booked: 'Booked', lost: 'Lost', disqualified: 'Not a fit', needs_human: 'Needs you', do_not_contact: 'Do not contact',
  };
  var MODE_FALLBACK_LABELS = {
    qualify_and_book: 'Qualify and book', soft_nurture: 'Soft nurture', direct_closer: 'Direct closer',
    noshow_recovery: 'No-show recovery', paused_human: 'Paused (human handling)',
  };

  // ---------- tiny DOM helper (textContent only: lead messages can never inject markup) ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    var kids = [];
    for (var i = 2; i < arguments.length; i++) kids.push(arguments[i]);
    for (var k in (attrs || {})) {
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'class') el.className = attrs[k];
      else if (k === 'onclick') el.addEventListener('click', attrs[k]);
      else if (k === 'onkeydown') el.addEventListener('keydown', attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]);
    }
    for (var j = 0; j < kids.length; j++) {
      var c = kids[j];
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
  function say(msg, bad) { var s = $('status'); s.textContent = msg; s.className = bad ? 'err' : 'good'; }
  function when(iso) { return iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'not yet'; }
  function day(iso) { return iso ? new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : ''; }
  function pretty(s) { return s ? String(s).replace(/_/g, ' ') : ''; }
  function money(cents) { return '$' + ((Number(cents) || 0) / 100).toFixed(2); }
  function lines(textarea) { return textarea.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean); }
  function listText(arr) { return (arr || []).join('\n'); }

  // ---------- API ----------
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { 'Authorization': 'Bearer ' + state.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (r) {
      if (r.status === 401) { logout(); throw new Error('Wrong password. Please log in again.'); }
      return r.json().then(function (j) {
        if (!r.ok) {
          var msg = (j && (j.message || j.error)) || 'Request failed (' + r.status + ')';
          if (j && j.issues && j.issues.length) msg = 'Some fields are missing or out of range: ' + j.issues.map(function (x) { return x.path.join('.'); }).join(', ');
          throw new Error(msg);
        }
        return j;
      });
    });
  }
  function fail(e) { say(e.message || 'Something went wrong', true); }

  // ---------- theme ----------
  function applyTheme() {
    var saved = lsGet('dms_theme');
    var sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var dark = saved ? saved === 'dark' : sysDark;
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }
  applyTheme();
  $('theme-toggle').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    lsSet('dms_theme', cur);
    applyTheme();
    say('Switched to the ' + cur + ' look.');
  });

  // ---------- login / logout ----------
  function logout() {
    state.token = ''; ssDel('dms_token');
    state.clients = []; state.clientId = '';
    $('clientbox').hidden = true;
    location.hash = '#login';
    render();
  }
  $('logout').addEventListener('click', logout);

  function renderLogin() {
    document.title = 'Log in — DM Setter';
    var form = h('form', { class: 'card', style: 'max-width:26rem;margin:9vh auto 0;' },
      h('h1', { text: 'Welcome back' }),
      h('p', { class: 'sub', text: 'One shared password for you and your team. It is the ADMIN_TOKEN you set when you deployed.' }),
      h('label', { for: 'token' }, 'Admin password'),
      h('input', { id: 'token', type: 'password', autocomplete: 'current-password', 'aria-describedby': 'token-hint', required: true }),
      h('p', { id: 'token-hint', class: 'hint', text: 'Kept only in this browser tab. Nothing is stored on the server side of this page.' }),
      h('p', {}, h('button', { type: 'submit', text: 'Log in' })));
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      state.token = form.querySelector('#token').value.trim();
      api('GET', '/api/clients').then(function (list) {
        ssSet('dms_token', state.token);
        state.clients = list;
        location.hash = '#home';
        render();
        say('Logged in.');
      }).catch(function (err) { state.token = ''; fail(err); });
    });
    var page = $('page'); clear(page); page.appendChild(form);
  }

  // ---------- clients ----------
  function ensureClientId() {
    if (!state.clients.length) return null;
    var ids = state.clients.map(function (c) { return c.id; });
    if (!state.clientId || ids.indexOf(state.clientId) === -1) state.clientId = ids[0];
    lsSet('dms_client', state.clientId);
    return state.clientId;
  }
  function currentClient() {
    for (var i = 0; i < state.clients.length; i++) if (state.clients[i].id === state.clientId) return state.clients[i];
    return state.clients[0] || null;
  }
  function fillClientSelect() {
    var box = $('clientbox');
    if (!state.clients.length) { box.hidden = true; return; }
    box.hidden = false;
    var sel = $('client-select'); clear(sel);
    state.clients.forEach(function (c) {
      var o = h('option', { value: c.id, text: c.name });
      if (c.id === state.clientId) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = function () {
      state.clientId = this.value;
      lsSet('dms_client', this.value);
      state.askHistory = [];
      render();
    };
  }
  function requireClient(page) {
    if (!state.clients.length) { renderNoClients(page); return false; }
    ensureClientId();
    fillClientSelect();
    return true;
  }
  function renderNoClients(page) {
    var div = h('div', { class: 'card' },
      h('h1', { text: 'Add your first business' }),
      h('p', { class: 'sub', text: 'The AI works per business: its offer, its tone, its rules. Add one and every other page fills up.' }),
      h('p', {}, h('button', { type: 'button', text: 'Add a business', onclick: function () { location.hash = '#clients'; } })));
    clear($('page')); $('page').appendChild(div);
  }

  // ---------- router ----------
  var TITLES = {
    home: 'Home', pipeline: 'Pipeline', conversations: 'Conversations', comments: 'Comments',
    clients: 'Clients', studio: 'AI Studio', ask: 'Ask AI', health: 'Health & help', login: 'Log in',
  };
  var RENDERERS = {};
  // renderLogin is a function declaration (hoisted), so it can be registered here.
  // A missing registration meant every first visit (no stored token → login route)
  // crashed the router and left the main area blank. Never let that happen again.
  RENDERERS.login = renderLogin;
  function render() {
    var route = (location.hash || '#home').replace('#', '') || 'home';
    if (route === 'test') route = 'studio';
    if (!RENDERERS[route]) route = 'home';
    if (!state.token) route = 'login';
    if (!RENDERERS[route]) route = 'home';       // belt and braces: never crash the router
    if (!RENDERERS[route]) { renderLogin(); return; }
    closeSidebar();
    clear($('page'));
    $('status').textContent = '';
    $('mob-title').textContent = TITLES[route] || 'DM Setter';
    document.title = (TITLES[route] || 'DM Setter') + ' — DM Setter';
    var navs = document.querySelectorAll('.side-nav a');
    for (var i = 0; i < navs.length; i++) {
      if (navs[i].getAttribute('data-nav') === route) navs[i].setAttribute('aria-current', 'page');
      else navs[i].removeAttribute('aria-current');
    }
    try {
      RENDERERS[route]();
    } catch (err) {
      // A page that throws must still paint something (never a blank main area).
      var page = $('page'); clear(page);
      page.appendChild(h('div', { class: 'card' },
        h('h1', { text: 'This page hit a snag' }),
        h('p', { class: 'sub', text: String((err && err.message) || err) + ' — refresh the page; your data is unaffected.' })));
    }
    $('main').focus({ preventScroll: false });
  }
  window.addEventListener('hashchange', render);

  // ---------- mobile sidebar ----------
  function closeSidebar() {
    $('sidebar').classList.remove('open');
    $('scrim').hidden = true;
    $('menu-btn').setAttribute('aria-expanded', 'false');
  }
  $('menu-btn').addEventListener('click', function () {
    var open = !$('sidebar').classList.contains('open');
    $('sidebar').classList.toggle('open', open);
    $('scrim').hidden = !open;
    this.setAttribute('aria-expanded', String(open));
  });
  $('scrim').addEventListener('click', closeSidebar);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeSidebar(); closeConvModal(); }
  });

  // ---------- modal (conversation detail) ----------
  var modalReturnFocus = null;
  function closeConvModal() {
    var root = $('modal-root'); clear(root);
    if (modalReturnFocus && document.body.contains(modalReturnFocus)) { modalReturnFocus.focus(); modalReturnFocus = null; }
  }
  function openConvModal(convId, opener) {
    modalReturnFocus = opener || null;
    say('Loading conversation…');
    var body = h('div', { class: 'stack' });
    var refresh = function () {
      api('GET', '/api/conversations/' + convId).then(function (fresh) {
        clear(body);
        fillConversationBody(body, fresh, refresh);
      }).catch(fail);
    };
    api('GET', '/api/conversations/' + convId).then(function (d) {
      var root = $('modal-root'); clear(root);
      var dlg = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Conversation with @' + (d.conversation.username || 'unknown') },
        h('div', { class: 'row spread' },
          h('h2', { text: '@' + (d.conversation.username || 'unknown'), style: 'margin:0;' }),
          h('button', { type: 'button', class: 'secondary small', text: 'Close', onclick: closeConvModal })),
        body);
      var overlay = h('div', { class: 'overlay' }, dlg);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) closeConvModal(); });
      root.appendChild(overlay);
      fillConversationBody(body, d, refresh);
      dlg.querySelector('button').focus();
      say('Conversation opened.');
    }).catch(fail);
  }

// __JS_PART_2__

  // ---------- shared conversation pieces ----------
  function modeOptions() {
    var out = [{ value: '', label: 'Business default' }];
    state.modes.forEach(function (m) { if (m.id !== 'paused_human') out.push({ value: m.id, label: m.label }); });
    out.push({ value: 'paused_human', label: 'Paused (human handling)' });
    return out;
  }
  function modeLabel(id) {
    for (var i = 0; i < state.modes.length; i++) if (state.modes[i].id === id) return state.modes[i].label;
    return MODE_FALLBACK_LABELS[id] || pretty(id) || 'Business default';
  }
  function messagesEl(messages) {
    var box = h('div', { class: 'msgs', 'aria-label': 'Chat messages' });
    (messages || []).forEach(function (m) {
      var lead = m.direction === 'in';
      var bubble = h('div', { class: 'msg ' + (lead ? 'in' : 'out') },
        h('div', { text: m.body }),
        h('div', { class: 'meta', text: (lead ? 'Lead · ' : 'Assistant · ') + when(m.at) }));
      box.appendChild(bubble);
    });
    if (!messages || !messages.length) box.appendChild(h('p', { class: 'empty', text: 'No messages yet.' }));
    return box;
  }
  function milestonesEl(milestones) {
    var ol = h('ol', { class: 'needlist', 'aria-label': 'What has happened so far' });
    var icons = { booking_link_sent: '➜', comment_dm_sent: '❑', human_takeover: '✋', ai_resumed: '▶', opt_out: '⛔', window_blocked: '⏰', next_followup: '⏱' };
    (milestones || []).forEach(function (m) {
      ol.appendChild(h('li', {},
        h('span', { class: 'dot', text: icons[m.kind] || '·', 'aria-hidden': 'true' }),
        h('div', { class: 'what' },
          h('b', { text: m.label }),
          h('div', { class: 'detail', text: (m.atLocal || 'unknown time') + (m.detail ? ' — ' + m.detail : '') }))));
    });
    if (!milestones || !milestones.length) ol.appendChild(h('p', { class: 'empty', text: 'Nothing notable yet.' }));
    return ol;
  }
  function askAboutLead(convId, container) {
    var ta = h('textarea', { id: 'bot-q', 'aria-label': 'Ask about this lead', placeholder: 'e.g. How does this person talk? What objections came up? When did we send the booking link?' });
    var out = h('div', {});
    var btn = h('button', { type: 'submit', class: 'small', text: 'Ask about this lead' });
    var form = h('form', {},
      h('label', { for: 'bot-q' }, 'Ask about this lead'),
      ta,
      h('p', { class: 'hint', text: 'The answer uses only this conversation, and quotes the person word for word with times.' }),
      h('p', {}, btn), out);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = ta.value.trim();
      if (!q) { say('Type a question about the lead first.', true); return; }
      btn.disabled = true; say('Thinking…'); clear(out);
      api('POST', '/api/conversations/' + convId + '/ask', { question: q }).then(function (r) {
        clear(out);
        out.appendChild(h('div', { class: 'ai-msg bot', text: r.answer }));
        if (r.unverifiedQuotes && r.unverifiedQuotes.length) {
          out.appendChild(h('p', { class: 'hint', text: 'Heads up: the model invented a quote, so this answer was rebuilt from the raw thread data instead.' }));
        }
        (r.references || []).forEach(function (x) {
          out.appendChild(h('blockquote', { style: 'border-left:3px solid var(--line-strong);margin:8px 0;padding:4px 10px;color:var(--muted);font-size:0.88rem;' },
            x.atLocal + ' · ' + (x.who === 'lead' ? 'Lead' : 'Us') + ': “' + x.quote + '”'));
        });
        say('Answer ready.');
      }).catch(fail).finally(function () { btn.disabled = false; });
    });
    container.appendChild(form);
  }
  function fillConversationBody(container, d, refresh) {
    var c = d.conversation;
    var paused = c.humanTakeover || c.mode === 'paused_human';

    var modeSel = h('select', { id: 'd-mode', 'aria-label': 'How the AI handles this thread' });
    modeOptions().forEach(function (o) {
      var op = h('option', { value: o.value, text: o.label });
      if ((c.mode || '') === o.value) op.selected = true;
      modeSel.appendChild(op);
    });
    var callSel = h('select', { id: 'd-call', 'aria-label': 'Call status' });
    CALLS.forEach(function (v) {
      var op = h('option', { value: v, text: CALL_LABELS[v] });
      if (c.callStatus === v) op.selected = true;
      callSel.appendChild(op);
    });

    var details = h('div', {},
      h('dl', { class: 'dl' },
        h('dt', { text: 'Where they stand' }), h('dd', {}, h('span', { class: 'tag ' + (c.state === 'needs_human' ? 'bad' : 'accent'), text: STATE_LABELS[c.state] || pretty(c.state) })),
        h('dt', { text: 'How interested they seem' }), h('dd', { text: c.leadScore == null ? 'Not scored yet' : c.leadScore + ' out of 100' }),
        h('dt', { text: 'How they found us' }), h('dd', { text: c.source === 'comment_opener' ? 'We DM’d them after they commented' : c.source === 'story_reply' ? 'They replied to a story' : c.source === 'ad_comment' ? 'They commented on an ad' : 'They messaged first' }),
        h('dt', { text: 'Call status' }), h('dd', { text: CALL_LABELS[c.callStatus] || pretty(c.callStatus) }),
        h('dt', { text: 'Next follow-up' }),
        h('dd', { text: c.nextFollowUpAt ? when(c.nextFollowUpAt) + (c.goal ? ' — ' + (GOAL_LABELS[c.goal] || pretty(c.goal)) : '') : 'None planned' }),
        h('dt', { text: 'Booking link sent' }), h('dd', { text: c.bookingLinkSentAt ? when(c.bookingLinkSentAt) : 'Not yet' }),
        h('dt', { text: 'DM’d from comment' }), h('dd', { text: c.commentDmSentAt ? when(c.commentDmSentAt) : 'No' }),
        h('dt', { text: 'AI state' }), h('dd', {}, paused ? h('span', { class: 'tag bad', text: 'Paused — a human is handling this' }) : h('span', { class: 'tag ok', text: 'AI is answering' }))));

    var actions = h('div', { class: 'row', style: 'margin-top:10px;' },
      h('button', { type: 'button', class: paused ? 'secondary' : 'danger', text: paused ? 'Hand back to the AI' : 'Pause the AI — take over myself',
        onclick: function () {
          var path = paused ? '/handback' : '/takeover';
          api('POST', '/api/conversations/' + c.id + path).then(function () {
            say(paused ? 'Handed back. The AI picks this thread up again.' : 'You have it. The AI will not send anything here.');
            refresh();
          }).catch(fail);
        } }));

    var left = h('div', {},
      h('h3', { text: 'The chat' }), messagesEl(d.messages),
      h('h3', { text: 'What has happened so far' }), milestonesEl(d.milestones));
    var right = h('div', {},
      h('h3', { text: 'Lead details' }), details,
      h('h3', { text: 'Switches for this thread' }),
      h('label', { for: 'd-mode' }, 'How the AI handles this thread'),
      modeSel,
      h('p', { class: 'hint', text: 'Thread setting wins over the business default. Paused means the AI sends nothing here.' }),
      h('p', {}, h('button', { type: 'button', class: 'secondary small', text: 'Apply mode', onclick: function () {
        api('POST', '/api/conversations/' + c.id + '/mode', { mode: modeSel.value || null }).then(function () { say('Mode updated.'); refresh(); }).catch(fail);
      } })),
      h('label', { for: 'd-call' }, 'Call status'),
      callSel,
      h('p', { class: 'hint', text: 'Keeps the nudges honest: confirming a call cancels “please book” messages; a no-show starts gentle rebooking.' }),
      h('p', {}, h('button', { type: 'button', class: 'secondary small', text: 'Apply call status', onclick: function () {
        api('POST', '/api/conversations/' + c.id + '/call-status', { status: callSel.value }).then(function () { say('Call status updated.'); refresh(); }).catch(fail);
      } })),
      actions,
      h('h3', { text: 'Ask about this lead' }),
      (function () { var box = h('div', {}); askAboutLead(c.id, box); return box; })());

    if (container.dataset && container.dataset.twocol === '1') {
      container.appendChild(h('div', { class: 'chatwrap' }, h('div', {}, right), h('div', {}, left)));
    } else {
      container.appendChild(details);
      container.appendChild(h('hr', { class: 'divider' }));
      container.appendChild(left);
      container.appendChild(h('div', {}, right));
    }
  }

  // ---------- HOME ----------
  function metricEl(label, value, small) {
    return h('div', { class: 'metric' }, h('dt', { text: label }), h('dd', { text: value }), small ? h('small', { text: small }) : null);
  }
  var NEED_TAGS = {
    needs_human: ['Handoff to you', 'bad'], flagged_comment: ['Flagged comment', 'bad'],
    held_comment: ['Held for review', 'warn'], no_show: ['Missed their call', 'warn'], cancelled_call: ['Call cancelled', 'warn'],
  };
  RENDERERS.home = function () {
    if (!requireClient()) return;
    var page = $('page');
    var client = currentClient();
    page.appendChild(h('h1', { text: 'Hi — here is today for ' + client.name }));
    page.appendChild(h('p', { class: 'sub', text: new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) + ' · numbers reset at local midnight.' }));

    var metrics = h('div', { class: 'metrics', 'aria-label': "Today's numbers" });
    var needsList = h('ul', { class: 'needlist' });
    page.appendChild(metrics);
    page.appendChild(h('div', { class: 'card' },
      h('div', { class: 'row spread' },
        h('div', {}, h('h2', { text: 'Needs you' }), h('p', { class: 'sub', text: 'Angry leads, handoffs, held comments, no-shows — the things the AI steps back from.' })),
        h('span', { id: 'worker-chip' })),
      needsList));
    page.appendChild(buildAskBox(true));

    api('GET', '/api/clients/' + state.clientId + '/overview').then(function (o) {
      clear(metrics);
      metrics.appendChild(metricEl('Messages sent today', String(o.today.dmsSent)));
      metrics.appendChild(metricEl('Replies from leads today', String(o.today.repliesIn)));
      metrics.appendChild(metricEl('New leads today', String(o.today.newLeads)));
      metrics.appendChild(metricEl('Calls booked today', String(o.today.callsBooked)));
      metrics.appendChild(metricEl('Sales today', money(o.today.revenueCents), o.today.sales + (o.today.sales === 1 ? ' sale' : ' sales')));
      metrics.appendChild(metricEl('Comment DMs today', String(o.today.commentDmsSent), o.today.openersPending + ' waiting in queue'));

      var chip = $('worker-chip'); clear(chip);
      if (o.workerAlive === true) chip.appendChild(h('span', { class: 'tag ok', text: 'Worker running' }));
      else if (o.workerAlive === false) chip.appendChild(h('span', { class: 'tag bad', text: 'Worker not responding' }));
      else chip.appendChild(h('span', { class: 'tag', text: 'Worker not checked in yet' }));

      clear(needsList);
      if (!o.needsYou.length) {
        needsList.appendChild(h('li', {}, h('div', { class: 'what' }, h('b', { text: 'Nothing needs you right now.' }),
          h('div', { class: 'detail', text: 'The AI has everything covered. New handoffs and held comments will show up here.' }))));
      }
      o.needsYou.forEach(function (item) {
        var t = NEED_TAGS[item.kind] || [pretty(item.kind), ''];
        var li = h('li', {},
          h('span', { class: 'tag ' + t[1], text: t[0] }),
          h('div', { class: 'what' },
            h('b', { text: item.title }),
            h('div', { class: 'detail', text: item.detail + (item.at ? ' · ' + when(item.at) : '') })),
          item.conversationId ? h('button', { type: 'button', class: 'secondary small', text: 'Open chat', onclick: function (e) { openConvModal(item.conversationId, e.target); } }) : null,
          item.commentId ? h('button', { type: 'button', class: 'secondary small', text: 'Review comment', onclick: function () { location.hash = '#comments'; } }) : null);
        needsList.appendChild(li);
      });
      updateNeedBadge(o.counts.heldComments + o.counts.flaggedComments);
    }).catch(fail);
  };
  function updateNeedBadge(n) {
    state.lastNeedCount = n;
    var navs = document.querySelectorAll('.side-nav a[data-nav="comments"] .navbadge, #mob-count');
    for (var i = 0; i < navs.length; i++) {
      clear(navs[i]);
      if (n > 0) { navs[i].hidden = false; navs[i].appendChild(document.createTextNode(String(n))); }
      else navs[i].hidden = true;
    }
    var commentsNav = document.querySelector('.side-nav a[data-nav="comments"]');
    var old = commentsNav && commentsNav.querySelector('.navbadge');
    if (old) old.remove();
    if (n > 0 && commentsNav) commentsNav.appendChild(h('span', { class: 'navbadge', text: String(n) }));
  }
  function buildAskBox(small) {
    var ta = h('textarea', { id: 'home-ask', 'aria-label': 'Ask your AI', placeholder: 'e.g. Who is hottest right now? Why did comments drop this week?' });
    var out = h('div', { class: 'aichat' });
    var btn = h('button', { type: 'submit', class: small ? 'small' : '', text: 'Ask your AI' });
    var form = h('form', { class: 'card' },
      h('h2', { text: 'Ask your AI' }),
      h('p', { class: 'sub', text: 'Answers come from your real data only. It never changes anything on its own — it proposes, you confirm.' }),
      ta, h('p', {}, btn), out);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = ta.value.trim();
      if (!q) { say('Type a question first.', true); return; }
      btn.disabled = true; say('Thinking…'); clear(out);
      runAsk(q, out, []).then(function () { ta.value = ''; })
        .catch(fail).finally(function () { btn.disabled = false; });
    });
    return form;
  }

  // ---------- PIPELINE ----------
  var PIPE_COLS = [
    { key: 'new', title: 'New', states: ['new'] },
    { key: 'talking', title: 'Talking', states: ['qualifying', 'objection', 'scheduling', 'needs_human'] },
    { key: 'qualified', title: 'Qualified', states: ['qualified'] },
    { key: 'booked', title: 'Booked', states: ['booked'] },
    { key: 'lost', title: 'Lost', states: ['lost', 'disqualified', 'do_not_contact'] },
  ];
  RENDERERS.pipeline = function () {
    if (!requireClient()) return;
    var page = $('page');
    page.appendChild(h('h1', { text: 'Pipeline' }));
    page.appendChild(h('p', { class: 'sub', text: 'Every lead as a card, newest activity first. Click a card to read the whole chat.' }));
    var wrap = h('div', { class: 'pipe' });
    page.appendChild(wrap);

    api('GET', '/api/clients/' + state.clientId + '/pipeline').then(function (rows) {
      clear(wrap);
      PIPE_COLS.forEach(function (col) {
        var items = rows.filter(function (r) { return col.states.indexOf(r.state) !== -1; });
        var colEl = h('div', { class: 'pcol' }, h('h3', {}, col.title + ' ', h('span', { class: 'count', text: '(' + items.length + ')' })));
        if (!items.length) colEl.appendChild(h('p', { class: 'empty', text: 'Nobody here yet.' }));
        items.forEach(function (r) {
          var paused = r.humanTakeover || r.mode === 'paused_human';
          var card = h('button', { type: 'button', class: 'leadcard', onclick: function (e) { openConvModal(r.id, e.target); } },
            h('div', { class: 'row' },
              h('span', { class: 'who', text: '@' + (r.username || r.platformUserId) }),
              r.state === 'needs_human' ? h('span', { class: 'tag bad', text: 'Needs you' }) : null,
              paused ? h('span', { class: 'tag warn', text: 'AI paused' }) : null,
              r.doNotContact ? h('span', { class: 'tag', text: 'Do not contact' }) : null),
            h('div', { class: 'prev', text: r.lastMessage ? (r.lastDirection === 'in' ? '' : 'You: ') + r.lastMessage : 'No messages yet' }),
            h('div', { class: 'row', style: 'margin-top:6px;' },
              h('span', { class: 'tag accent', text: r.leadScore == null ? 'Interest: not scored' : 'Interest: ' + r.leadScore + '/100' }),
              h('span', { class: 'tag', text: day(r.lastInboundAt || r.lastOutboundAt) || 'new' })));
          colEl.appendChild(card);
        });
        wrap.appendChild(colEl);
      });
    }).catch(fail);
  };

// __JS_PART_3__

  // ---------- CONVERSATIONS (inbox) ----------
  var inboxState = { rows: [], openId: null, filter: '' };
  RENDERERS.conversations = function () {
    if (!requireClient()) return;
    var page = $('page');
    page.appendChild(h('h1', { text: 'Conversations' }));
    page.appendChild(h('p', { class: 'sub', text: 'Read every chat, pause the AI on a thread or take over yourself. If you reply from Instagram, the AI stays quiet automatically.' }));
    var wrap = h('div', { class: 'chatwrap' });
    var listCol = h('div', {}, h('label', { for: 'conv-filter', class: 'hint', style: 'font-weight:600;color:var(--fg);' }, 'Find a lead'),
      h('input', { id: 'conv-filter', type: 'search', placeholder: 'Search by name…', 'aria-label': 'Search conversations by name' }), h('p', { class: 'hint', text: 'Filters the list below as you type.' }), h('div', { class: 'convlist', id: 'convlist' }));
    var chatCol = h('div', { id: 'inbox-chat' });
    var detailCol = h('div', { id: 'inbox-detail' });
    wrap.appendChild(listCol); wrap.appendChild(chatCol); wrap.appendChild(detailCol);
    page.appendChild(wrap);

    $('conv-filter').addEventListener('input', function () { inboxState.filter = this.value.toLowerCase(); renderConvList(); });

    api('GET', '/api/clients/' + state.clientId + '/conversations').then(function (rows) {
      inboxState.rows = rows || [];
      if (!rows.length) {
        clear(chatCol);
        chatCol.appendChild(h('p', { class: 'empty', text: 'No conversations yet. They appear here the moment someone comments or messages you.' }));
        return;
      }
      if (!inboxState.openId || !rows.some(function (r) { return r.id === inboxState.openId; })) inboxState.openId = rows[0].id;
      renderConvList();
      openInboxConv(inboxState.openId);
    }).catch(fail);
  };
  function renderConvList() {
    var list = $('convlist'); clear(list);
    var rows = inboxState.rows.filter(function (r) {
      var who = '@' + (r.username || r.platformUserId);
      return !inboxState.filter || who.toLowerCase().indexOf(inboxState.filter) !== -1;
    });
    if (!rows.length) { list.appendChild(h('p', { class: 'empty', text: 'No lead matches that search.' })); return; }
    rows.forEach(function (r) {
      var paused = r.humanTakeover || r.mode === 'paused_human';
      var btn = h('button', { type: 'button', class: 'convrow', 'aria-current': String(r.id === inboxState.openId), onclick: function () {
        inboxState.openId = r.id;
        renderConvList();
        openInboxConv(r.id);
      } },
        h('div', { class: 'row' }, h('span', { class: 'who', text: '@' + (r.username || r.platformUserId) }),
          r.state === 'needs_human' ? h('span', { class: 'tag bad', text: 'Needs you' }) : null,
          paused ? h('span', { class: 'tag warn', text: 'AI paused' }) : null),
        h('div', { class: 'prev', text: STATE_LABELS[r.state] || pretty(r.state) }));
      list.appendChild(btn);
    });
  }
  function openInboxConv(id) {
    var chat = $('inbox-chat'); var detail = $('inbox-detail');
    say('Loading conversation…');
    api('GET', '/api/conversations/' + id).then(function (d) {
      clear(chat); clear(detail);
      chat.appendChild(h('h2', { text: '@' + (d.conversation.username || 'unknown') }));
      chat.appendChild(messagesEl(d.messages));
      fillConversationSide(detail, d, function () { openInboxConv(id); });
      say('Conversation opened.');
    }).catch(fail);
  }
  /** Sidebar (right column) version of the details, without duplicating the chat. */
  function fillConversationSide(container, d, refresh) {
    var c = d.conversation;
    var paused = c.humanTakeover || c.mode === 'paused_human';
    var modeSel = h('select', { id: 'side-mode', 'aria-label': 'How the AI handles this thread' });
    modeOptions().forEach(function (o) {
      var op = h('option', { value: o.value, text: o.label });
      if ((c.mode || '') === o.value) op.selected = true;
      modeSel.appendChild(op);
    });
    var callSel = h('select', { id: 'side-call', 'aria-label': 'Call status' });
    CALLS.forEach(function (v) {
      var op = h('option', { value: v, text: CALL_LABELS[v] });
      if (c.callStatus === v) op.selected = true;
      callSel.appendChild(op);
    });
    container.appendChild(h('div', { class: 'card' },
      h('h2', { text: 'Lead details' }),
      h('dl', { class: 'dl' },
        h('dt', { text: 'Where they stand' }), h('dd', {}, h('span', { class: 'tag ' + (c.state === 'needs_human' ? 'bad' : 'accent'), text: STATE_LABELS[c.state] || pretty(c.state) })),
        h('dt', { text: 'How interested they seem' }), h('dd', { text: c.leadScore == null ? 'Not scored yet' : c.leadScore + ' out of 100' }),
        h('dt', { text: 'How they found us' }), h('dd', { text: c.source === 'comment_opener' ? 'DM’d after their comment' : c.source === 'story_reply' ? 'Replied to a story' : c.source === 'ad_comment' ? 'Commented on an ad' : 'Messaged first' }),
        h('dt', { text: 'Call status' }), h('dd', { text: CALL_LABELS[c.callStatus] || pretty(c.callStatus) }),
        h('dt', { text: 'Next follow-up' }), h('dd', { text: c.nextFollowUpAt ? when(c.nextFollowUpAt) + (c.goal ? ' — ' + (GOAL_LABELS[c.goal] || pretty(c.goal)) : '') : 'None planned' }),
        h('dt', { text: 'Booking link sent' }), h('dd', { text: c.bookingLinkSentAt ? when(c.bookingLinkSentAt) : 'Not yet' }),
        h('dt', { text: 'DM’d from comment' }), h('dd', { text: c.commentDmSentAt ? when(c.commentDmSentAt) : 'No' })),
      h('label', { for: 'side-mode' }, 'How the AI handles this thread'),
      modeSel,
      h('p', { class: 'hint', text: 'Thread setting wins over the business default.' }),
      h('p', {}, h('button', { type: 'button', class: 'secondary small', text: 'Apply mode', onclick: function () {
        api('POST', '/api/conversations/' + c.id + '/mode', { mode: modeSel.value || null }).then(function () { say('Mode updated.'); refresh(); }).catch(fail);
      } })),
      h('label', { for: 'side-call' }, 'Call status'),
      callSel,
      h('p', {}, h('button', { type: 'button', class: 'secondary small', text: 'Apply call status', onclick: function () {
        api('POST', '/api/conversations/' + c.id + '/call-status', { status: callSel.value }).then(function () { say('Call status updated.'); refresh(); }).catch(fail);
      } })),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: paused ? 'secondary' : 'danger', text: paused ? 'Hand back to the AI' : 'Pause the AI — take over myself',
          onclick: function () {
            var path = paused ? '/handback' : '/takeover';
            api('POST', '/api/conversations/' + c.id + path).then(function () {
              say(paused ? 'Handed back to the AI.' : 'You have it. The AI will not send anything here.');
              refresh();
            }).catch(fail);
          } })),
      h('hr', { class: 'divider' }),
      h('h3', { text: 'What has happened so far' }),
      milestonesEl(d.milestones),
      (function () { var box = h('div', {}); askAboutLead(c.id, box); return box; })()));
  }

  // ---------- COMMENTS ----------
  RENDERERS.comments = function () {
    if (!requireClient()) return;
    var page = $('page');
    page.appendChild(h('h1', { text: 'Comments' }));
    page.appendChild(h('p', { class: 'sub', text: 'How comments become DMs, and the ones waiting for your decision.' }));

    var results = h('div', { class: 'metrics', 'aria-label': 'Comment results, last 7 days' });
    var queue = h('div', { class: 'card' }, h('h2', { text: 'Held for review' }), h('p', { class: 'sub', text: 'These commenters scored below your bar, so the AI waited for you. Approving sends them a normal first DM within your daily limits.' }), h('div', { id: 'review-queue' }));
    var rules = h('div', { class: 'card', id: 'rules-card' });
    page.appendChild(results); page.appendChild(queue); page.appendChild(rules);

    api('GET', '/api/clients/' + state.clientId + '/overview').then(function (o) {
      clear(results);
      results.appendChild(metricEl('Comments checked (7 days)', String(o.comments7d.classified)));
      results.appendChild(metricEl('Became DM conversations', String(o.comments7d.becameDms)));
      results.appendChild(metricEl('Became bookings', String(o.comments7d.becameBookings)));
      results.appendChild(metricEl('Sales from those chats', money(o.comments7d.revenueCents)));
      results.appendChild(metricEl('Waiting for review', String(o.counts.heldComments)));
      results.appendChild(metricEl('Flagged for a human', String(o.counts.flaggedComments), '7 days'));
    }).catch(fail);

    api('GET', '/api/clients/' + state.clientId + '/review-comments').then(function (rows) {
      var box = $('review-queue'); clear(box);
      if (!rows.length) { box.appendChild(h('p', { class: 'empty', text: 'Nothing is waiting for review — the queue is clear.' })); return; }
      var tb = h('tbody', {});
      var table = h('table', {},
        h('caption', { text: 'Commenters waiting for your decision' }),
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col', text: 'Commenter' }), h('th', { scope: 'col', text: 'What they wrote' }),
          h('th', { scope: 'col', text: 'How interested they seem' }), h('th', { scope: 'col', text: 'Why it was held' }), h('th', { scope: 'col', text: 'Your call' }))), tb);
      var wrapEl = h('div', { class: 'scroll' }, table);
      box.appendChild(wrapEl);
      rows.forEach(function (cRow) {
        var who = '@' + (cRow.authorUsername || cRow.authorId);
        var approve = h('button', { type: 'button', class: 'small', text: 'Send them a DM', 'aria-label': 'Approve and send a first DM to ' + who,
          onclick: function () {
            approve.disabled = true;
            api('POST', '/api/comments/' + cRow.id + '/approve').then(function () { render(); say('Approved. The DM goes out within your daily limits.'); }).catch(function (e) { approve.disabled = false; fail(e); });
          } });
        var skip = h('button', { type: 'button', class: 'secondary small', text: 'Skip', 'aria-label': 'Skip ' + who,
          onclick: function () {
            skip.disabled = true;
            api('POST', '/api/comments/' + cRow.id + '/dismiss').then(function () { render(); say('Skipped. They will not get a DM.'); }).catch(function (e) { skip.disabled = false; fail(e); });
          } });
        tb.appendChild(h('tr', {},
          h('th', { scope: 'row', text: who }),
          h('td', { text: cRow.text }),
          h('td', { text: cRow.leadScore == null ? 'not scored' : cRow.leadScore + ' out of 100' }),
          h('td', { text: cRow.reason || '' }),
          h('td', {}, approve, skip)));
      });
    }).catch(fail);

    api('GET', '/api/clients/' + state.clientId).then(function (c) {
      renderRulesForm(rules, c);
    }).catch(fail);
  };
  function renderRulesForm(card, c) {
    clear(card);
    card.appendChild(h('h2', { text: 'Comment-to-DM rules, in plain words' }));
    card.appendChild(h('p', { class: 'sub', text: 'How the AI decides which commenters get a first DM, and how fast.' }));

    var modeSel = h('select', { id: 'c-mode' });
    state.modes.forEach(function (m) {
      var op = h('option', { value: m.id, text: m.label });
      if (c.defaultMode === m.id) op.selected = true;
      modeSel.appendChild(op);
    });
    var desc = h('p', { class: 'hint', id: 'c-mode-desc' });
    var updateDesc = function () {
      for (var i = 0; i < state.modes.length; i++) if (state.modes[i].id === modeSel.value) { desc.textContent = state.modes[i].description; return; }
      desc.textContent = '';
    };
    modeSel.addEventListener('change', updateDesc); updateDesc();

    var minIn = h('input', { id: 'c-min', type: 'number', min: '0', max: '100', value: String(c.minCommentDmScore) });
    var lowSel = h('select', { id: 'c-low' },
      h('option', { value: 'review', text: 'Hold them for my review' }),
      h('option', { value: 'public_reply_only', text: 'Reply publicly only, no DM' }),
      h('option', { value: 'skip', text: 'Skip them completely' }));
    lowSel.value = c.lowScoreAction;
    var maxIn = h('input', { id: 'c-max', type: 'number', min: '0', max: '1000', value: c.maxCommentDmsPerDay == null ? '' : String(c.maxCommentDmsPerDay) });
    var gapIn = h('input', { id: 'c-gap', type: 'number', min: '2', max: '240', value: String(c.commentDmMinGapMinutes) });
    var pauseIn = h('input', { id: 'c-pause', type: 'number', min: '1', max: '168', value: String(c.humanPauseHours) });

    var form = h('form', {},
      h('div', { class: 'grid2' },
        h('div', { class: 'field' },
          h('label', { for: 'c-mode' }, 'Default way the AI handles new chats'),
          modeSel, desc),
        h('div', { class: 'field' },
          h('label', { for: 'c-min' }, 'Lowest score to DM automatically (0–100)'),
          minIn,
          h('p', { class: 'hint', text: '0 turns the bar off: every interested commenter gets a DM. A commenter’s score mixes how interested they seem (60%) and how well they fit your ideal customer (40%).' })),
        h('div', { class: 'field' },
          h('label', { for: 'c-low' }, 'What to do with commenters below that score'),
          lowSel,
          h('p', { class: 'hint', text: '“Hold for my review” is the safe choice — they land in the queue above.' })),
        h('div', { class: 'field' },
          h('label', { for: 'c-max' }, 'Most comment DMs per day'),
          maxIn,
          h('p', { class: 'hint', text: 'Leave empty to use the account’s normal daily limit. Today: ' + c.commentDmsToday + ' of ' + c.commentDmCapToday + ' used.' })),
        h('div', { class: 'field' },
          h('label', { for: 'c-gap' }, 'Minimum minutes between comment DMs'),
          gapIn,
          h('p', { class: 'hint', text: 'Keeps the DMs spread out so Instagram never sees a burst. A few random extra minutes are added on top.' })),
        h('div', { class: 'field' },
          h('label', { for: 'c-pause' }, 'Hours the AI stays quiet after you reply yourself'),
          pauseIn,
          h('p', { class: 'hint', text: 'When a human types in a thread, the AI steps back for this long.' }))),
      h('p', { style: 'margin-top:16px;' }, h('button', { type: 'submit', text: 'Save rules' })));
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var max = maxIn.value.trim();
      api('PATCH', '/api/clients/' + state.clientId + '/controls', {
        defaultMode: modeSel.value,
        minCommentDmScore: Number(minIn.value || 0),
        lowScoreAction: lowSel.value,
        maxCommentDmsPerDay: max === '' ? null : Number(max),
        commentDmMinGapMinutes: Number(gapIn.value || 2),
        humanPauseHours: Number(pauseIn.value || 24),
      }).then(function () { say('Rules saved.'); renderRulesForm(card, c); }).catch(fail);
    });
    card.appendChild(form);
  }

// __JS_PART_4__

  // ---------- CLIENTS ----------
  function copyButton(text, label) {
    return h('button', { type: 'button', class: 'secondary small', text: 'Copy', 'aria-label': 'Copy ' + label, onclick: function () {
      var done = function () { say('Copied. Paste it into InstantDM.'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { done(); });
      else done();
    } });
  }
  RENDERERS.clients = function () {
    var page = $('page');
    page.appendChild(h('h1', { text: 'Clients' }));
    page.appendChild(h('p', { class: 'sub', text: 'Each business is separate: its own offer, tone, facts and rules. The AI never mixes them up.' }));

    var listCard = h('div', { class: 'card' },
      h('h2', { text: 'Your businesses' }),
      h('p', { class: 'sub', text: 'Pick one to edit, or add a new one.' }),
      h('div', { id: 'clients-list', class: 'row' }),
      h('p', {}, h('button', { type: 'button', class: 'secondary', text: '+ Add a business', onclick: function () { renderClientForm(null); } })));
    page.appendChild(listCard);
    page.appendChild(h('div', { id: 'client-form-slot' }));

    var listBox = listCard.querySelector('#clients-list');
    if (!state.clients.length) {
      clear(listBox);
      listBox.appendChild(h('p', { class: 'empty', text: 'No businesses yet. Add your first one — it takes about two minutes.' }));
      renderClientForm(null);
      return;
    }
    ensureClientId();
    state.clients.forEach(function (cRow) {
      listBox.appendChild(h('button', { type: 'button', class: 'chip', text: cRow.name, onclick: function () {
        state.clientId = cRow.id; lsSet('dms_client', cRow.id); fillClientSelect(); renderClientForm(cRow.id);
      } }));
    });
    renderClientForm(state.clientId);
  };
  function renderClientForm(clientId) {
    var slot = $('client-form-slot'); clear(slot);
    var isNew = !clientId;
    slot.appendChild(h('h2', { text: isNew ? 'Add a business' : 'Edit business', style: 'margin-top:26px;' }));

    var box = h('div', { class: 'card' });
    slot.appendChild(box);
    var webhookBox = h('div', { hidden: true });

    function f(id, labelText, hintText, attrs, tag) {
      var el = h(tag || 'input', Object.assign({ id: id }, attrs || {}));
      return h('div', { class: 'field' },
        h('label', { for: id }, labelText), el,
        hintText ? h('p', { class: 'hint', text: hintText }) : null);
    }
    var fTone = f('f-tone', 'How should it talk? (tone)', 'e.g. “Friendly, casual, a bit of humour. Short sentences.” The AI reads this on every message.', { type: 'text' });
    var fOffer = f('f-offer', 'What do you book people in for?', 'The actual thing the call is about. e.g. “A free 20-minute strategy call.”', { type: 'text' });
    var fIdeal = f('f-ideal', 'Who is a great fit?', 'Describe your ideal customer in a sentence or two — this drives who gets a DM and who does not.', { type: 'text' });
    var fSum = f('f-sum', 'What does the business do?', 'Two or three sentences. The AI uses this to answer “what is this about?”.', { type: 'text' });
    var fLink = f('f-link', 'Booking link', 'The only link the AI may ever send. Leave empty if you book by calendar instead.', { type: 'url', placeholder: 'https://cal.com/you/call' });
    var fKey = f('f-key', 'InstantDM API key', 'From your InstantDM dashboard. Used to send the DMs for this business.', { type: 'password', autocomplete: 'off' });
    var fIg = f('f-ig', 'Instagram account ID', 'The Instagram business account id InstantDM gave you for this account.', { type: 'text' });
    var fTz = f('f-tz', 'Timezone', 'Keeps “today” and quiet hours correct. e.g. America/Toronto or Europe/London.', { type: 'text', placeholder: 'America/Toronto' });
    // build the list/facts textareas:
    function ta(id, labelText, hintText, rows) {
      return h('div', { class: 'field' },
        h('label', { for: id }, labelText),
        h('textarea', { id: id, rows: rows || 3 }),
        hintText ? h('p', { class: 'hint', text: hintText }) : null);
    }

    var form = h('form', {},
      h('div', { class: 'grid2' },
        f('f-name', 'Business name', 'Shown only inside this dashboard.', { type: 'text', required: true }),
        fTz, fTone, fOffer, fIdeal, fSum, fLink, fKey, fIg),
      ta('f-facts', 'Facts the AI should know', 'Prices, process, FAQ answers — anything it may tell people. It may not invent facts, so put them here. One topic per paragraph.', 8),
      ta('f-dq2', 'Not a fit — who should get a polite no?', 'One per line. e.g. “People outside North America”.', 3),
      ta('f-qq', 'What to find out before booking', 'One per line. The AI asks these naturally, one at a time.', 3),
      ta('f-fc', 'Things it must never say', 'One per line. e.g. “guaranteed results”.', 3),
      h('p', {}, h('button', { type: 'submit', text: isNew ? 'Create business' : 'Save changes' })));
    box.appendChild(form);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var val = function (id) { var el = form.querySelector('#' + id); return el ? el.value.trim() : ''; };
      var payload = {
        name: val('f-name'),
        timezone: val('f-tz') || 'America/Toronto',
        platformApiKey: val('f-key'),
        instagramAccountId: val('f-ig'),
        settings: {
          tone: val('f-tone'), offer: val('f-offer'), idealCustomer: val('f-ideal'),
          businessSummary: val('f-sum'),
          bookingLink: val('f-link') || null,
        },
        knowledge: form.querySelector('#f-facts') ? form.querySelector('#f-facts').value : '',
      };
      if (!isNew) {
        if (!payload.platformApiKey) delete payload.platformApiKey;   // empty box = keep the stored key
        payload.settings.disqualifiers = lines(form.querySelector('#f-dq2'));
        payload.settings.qualificationQuestions = lines(form.querySelector('#f-qq'));
        payload.settings.forbiddenClaims = lines(form.querySelector('#f-fc'));
        api('PATCH', '/api/clients/' + clientId + '/settings', payload).then(function () {
          say('Saved. The AI reads the new settings from the very next message.');
          refreshClientsThen(function () { renderClientForm(clientId); });
        }).catch(fail);
        return;
      }
      payload.settings.disqualifiers = lines(form.querySelector('#f-dq2'));
      payload.settings.qualificationQuestions = lines(form.querySelector('#f-qq'));
      payload.settings.forbiddenClaims = lines(form.querySelector('#f-fc'));
      api('POST', '/api/clients', payload).then(function (r) {
        say('Business created.');
        clear(webhookBox); webhookBox.hidden = false;
        webhookBox.appendChild(h('div', { class: 'card', style: 'margin-top:16px;' },
          h('h2', { text: 'Almost done: connect InstantDM' }),
          h('p', { class: 'sub', text: 'Paste this webhook link into InstantDM for this Instagram account. Every comment and DM then flows into this dashboard.' }),
          h('p', { class: 'mono', text: r.webhookUrl }),
          h('p', {}, copyButton(r.webhookUrl, 'the InstantDM webhook link')),
          h('p', { class: 'sub', style: 'margin-top:10px;' }, 'Optional: if you use Cal.com or a CRM, this second link tells the AI about booked, cancelled and missed calls.'),
          h('p', { class: 'mono', text: r.calendarWebhookUrl }),
          h('p', {}, copyButton(r.calendarWebhookUrl, 'the calendar webhook link'))));
        refreshClientsThen(function () { location.hash = '#clients'; });
      }).catch(fail);
    });

    if (!isNew) {
      api('GET', '/api/clients/' + clientId + '/settings').then(function (full) {
        var set = function (id, v) { var el = form.querySelector('#' + id); if (el) el.value = v == null ? '' : String(v); };
        set('f-name', full.name); set('f-tz', full.timezone); set('f-tone', full.settings.tone);
        set('f-offer', full.settings.offer); set('f-ideal', full.settings.idealCustomer); set('f-sum', full.settings.businessSummary);
        set('f-link', full.settings.bookingLink); set('f-key', full.platformApiKey); set('f-ig', full.instagramAccountId);
        set('f-facts', full.knowledge); set('f-dq2', listText(full.settings.disqualifiers));
        set('f-qq', listText(full.settings.qualificationQuestions)); set('f-fc', listText(full.settings.forbiddenClaims));
        var wc = h('div', {},
          h('h3', { text: 'Webhook links for this business' }),
          h('p', { class: 'hint', text: 'These connect the Instagram account to this dashboard. Copy them into InstantDM (and your calendar) if you have not already.' }),
          h('p', { class: 'mono', text: full.webhookUrl }),
          h('p', {}, copyButton(full.webhookUrl, 'the InstantDM webhook link')),
          h('p', { class: 'mono', text: full.calendarWebhookUrl }),
          h('p', {}, copyButton(full.calendarWebhookUrl, 'the calendar webhook link')));
        box.appendChild(h('hr', { class: 'divider' })); box.appendChild(wc);
      }).catch(fail);
    }
  }
  function refreshClientsThen(fn) {
    api('GET', '/api/clients').then(function (list) {
      state.clients = list;
      ensureClientId();
      fillClientSelect();
      fn();
    }).catch(fail);
  }

  // ---------- AI STUDIO ----------
  RENDERERS.studio = function () {
    if (!requireClient()) return;
    var page = $('page');
    page.appendChild(h('h1', { text: 'AI Studio' }));
    page.appendChild(h('p', { class: 'sub', text: 'Tune how the AI sounds and what it knows, try it as a pretend lead — then push it live. None of this changes the AI’s core rules: it still never invents facts, still hands off to you, still respects every guard rail.' }));

    var settingsCard = h('div', { class: 'card', id: 'studio-settings' });
    var describeCard = h('div', { class: 'card' });
    var testCard = h('div', { class: 'card' });
    page.appendChild(settingsCard); page.appendChild(describeCard); page.appendChild(testCard);

    api('GET', '/api/clients/' + state.clientId + '/settings').then(function (full) {
      renderStudioSettings(settingsCard, full);
      renderDescribeBox(describeCard, full);
    }).catch(fail);
    renderTestChat(testCard);
  };

  function renderStudioSettings(card, full) {
    clear(card);
    card.appendChild(h('h2', { text: 'What the AI reads on every message' }));
    card.appendChild(h('p', { class: 'sub', text: 'Edit directly, or use the describe-it box below and let the AI draft the change first.' }));

    function ta(id, labelText, hintText, value, rows) {
      var el = h('textarea', { id: id, rows: rows || 3 });
      el.value = value == null ? '' : String(value);
      return h('div', { class: 'field', style: 'max-width:46rem;' },
        h('label', { for: id }, labelText), el, h('p', { class: 'hint', text: hintText }));
    }
    function inp(id, labelText, hintText, value) {
      var el = h('input', { id: id, type: 'text' });
      el.value = value == null ? '' : String(value);
      return h('div', { class: 'field' }, h('label', { for: id }, labelText), el, h('p', { class: 'hint', text: hintText }));
    }
    var form = h('form', {},
      inp('s-tone', 'Tone', 'How it should sound. e.g. “Friendly and casual. Never mention price before they ask.”', full.settings.tone),
      inp('s-offer', 'What we book people in for', 'The offer the call is about.', full.settings.offer),
      inp('s-ideal', 'Ideal customer', 'Who this is perfect for.', full.settings.idealCustomer),
      inp('s-sum', 'What the business does', 'Two or three sentences about the business.', full.settings.businessSummary),
      ta('s-dq', 'Not a fit (politely disqualify)', 'One per line.', listText(full.settings.disqualifiers)),
      ta('s-qq', 'Things to find out before booking', 'One per line. Asked naturally, never as a questionnaire.', listText(full.settings.qualificationQuestions)),
      ta('s-fc', 'Never say these', 'Exact phrases or claims that are off-limits. One per line.', listText(full.settings.forbiddenClaims)),
      ta('s-kb', 'Facts file (knowledge base)', 'Everything it may tell people: prices, process, FAQs. It may not invent facts — anything missing here, it will not say.', full.knowledge, 10),
      inp('s-link', 'Booking link', 'The only link it may ever send.', full.settings.bookingLink),
      h('p', { style: 'margin-top:14px;' }, h('button', { type: 'submit', text: 'Save settings' })));
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      api('PATCH', '/api/clients/' + state.clientId + '/settings', {
        settings: {
          tone: form.querySelector('#s-tone').value.trim(),
          offer: form.querySelector('#s-offer').value.trim(),
          idealCustomer: form.querySelector('#s-ideal').value.trim(),
          businessSummary: form.querySelector('#s-sum').value.trim(),
          disqualifiers: lines(form.querySelector('#s-dq')),
          qualificationQuestions: lines(form.querySelector('#s-qq')),
          forbiddenClaims: lines(form.querySelector('#s-fc')),
          bookingLink: form.querySelector('#s-link').value.trim() || null,
        },
        knowledge: form.querySelector('#s-kb').value,
      }).then(function () { say('Saved. The AI reads the new settings from the very next message.'); }).catch(fail);
    });
    card.appendChild(form);
  }

  function renderDescribeBox(card, full) {
    clear(card);
    card.appendChild(h('h2', { text: 'Describe-it box' }));
    card.appendChild(h('p', { class: 'sub', text: 'Type what you want in your own words. You will see the exact changes before anything is applied — and you press Apply. It can only change what the AI reads (tone, offer, rules, facts), never how it works inside.' }));
    var req = h('textarea', { id: 'describe-req', 'aria-label': 'Describe the change you want', placeholder: 'e.g. Make it more casual, and never mention price first. Also add “we ship from Canada” to the facts.' });
    var out = h('div', {});
    var showBtn = h('button', { type: 'button', text: 'Show me the changes' });
    showBtn.addEventListener('click', function () {
      var request = req.value.trim();
      if (request.length < 3) { say('Describe the change first.', true); return; }
      showBtn.disabled = true; say('Drafting the change…'); clear(out);
      api('POST', '/api/clients/' + state.clientId + '/describe', { request: request }).then(function (r) {
        clear(out);
        out.appendChild(h('h3', { text: 'Proposed change' }));
        out.appendChild(h('p', { text: r.summary || '' }));
        if (!r.changes.length) { out.appendChild(h('p', { class: 'empty', text: 'No changes needed — the settings already match what you described.' })); return; }
        var tb = h('tbody', {});
        r.changes.forEach(function (ch) {
          tb.appendChild(h('tr', {},
            h('th', { scope: 'row', text: ch.label }),
            h('td', { text: ch.before === '' ? '(empty)' : ch.before }),
            h('td', { text: ch.after === '' ? '(empty)' : ch.after }),
            h('td', { text: ch.explanation || '' })));
        });
        out.appendChild(h('div', { class: 'scroll' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Setting' }), h('th', { scope: 'col', text: 'Before' }), h('th', { scope: 'col', text: 'After' }), h('th', { scope: 'col', text: 'Why' }))), tb)));
        var applyBtn = h('button', { type: 'button', text: 'Apply these changes' });
        var cancelBtn = h('button', { type: 'button', class: 'secondary', text: 'Discard', onclick: function () { clear(out); say('Discarded — nothing was changed.'); } });
        applyBtn.addEventListener('click', function () {
          applyBtn.disabled = true;
          api('POST', '/api/clients/' + state.clientId + '/describe/apply', { changes: r.changes.map(function (ch) { return { field: ch.field, value: ch.afterRaw }; }) }).then(function () {
            // Update the visible fields in place (no full re-render, so the confirmation stays).
            var FIELD_IDS = { tone: 's-tone', offer: 's-offer', idealCustomer: 's-ideal', businessSummary: 's-sum',
              disqualifiers: 's-dq', qualificationQuestions: 's-qq', forbiddenClaims: 's-fc', knowledge: 's-kb', bookingLink: 's-link' };
            r.changes.forEach(function (ch) {
              var el = document.getElementById(FIELD_IDS[ch.field]);
              if (el) el.value = Array.isArray(ch.afterRaw) ? listText(ch.afterRaw) : (ch.afterRaw == null ? '' : String(ch.afterRaw));
            });
            say('Applied. The AI reads the new settings from the very next message.');
          }).catch(function (e) { applyBtn.disabled = false; fail(e); });
        });
        out.appendChild(h('p', { style: 'margin-top:12px;' }, applyBtn, cancelBtn));
        say('Change drafted. Review it, then press Apply.');
      }).catch(fail).finally(function () { showBtn.disabled = false; });
    });
    card.appendChild(h('div', { class: 'field', style: 'max-width:46rem;' },
      h('label', { for: 'describe-req' }, 'What do you want changed?'), req,
      h('p', { class: 'hint', text: 'Nothing changes until you press Apply.' })));
    card.appendChild(h('p', {}, showBtn));
    card.appendChild(out);
  }

  function renderTestChat(card) {
    clear(card);
    card.appendChild(h('h2', { text: 'Test chat — be a pretend lead' }));
    card.appendChild(h('p', { class: 'sub', text: 'Talk to your AI exactly like a stranger would. Same brain, same rules as production — but nothing is sent, saved or booked while you are here.' }));
    var msgs = h('div', { class: 'msgs', 'aria-label': 'Test chat messages', style: 'min-height:120px;' });
    var ta = h('input', { id: 'test-msg', type: 'text', placeholder: 'Type what a lead would say…', 'aria-label': 'Message as the pretend lead' });
    var send = h('button', { type: 'button', class: 'small', text: 'Send as lead' });
    var history = [];
    var toolsOut = h('p', { class: 'hint' });
    msgs.appendChild(h('p', { class: 'empty', text: 'The conversation starts here. Try: “hey how much is it?” or “not sure this is for me”.' }));
    send.addEventListener('click', function () {
      var message = ta.value.trim();
      if (!message) { say('Type a message first.', true); return; }
      send.disabled = true; ta.disabled = true;
      history.push({ direction: 'in', body: message });
      msgs.appendChild(h('div', { class: 'msg in' }, h('div', { text: message }), h('div', { class: 'meta', text: 'Pretend lead · just now' })));
      api('POST', '/api/clients/' + state.clientId + '/test-chat', { message: message, history: history.slice(0, -1) }).then(function (r) {
        if (r.error) {
          msgs.appendChild(h('div', { class: 'msg out' }, h('div', { text: r.error })));
          say('The AI could not reply just now.', true);
        } else {
          history.push({ direction: 'out', body: r.reply || '' });
          msgs.appendChild(h('div', { class: 'msg out' }, h('div', { text: r.reply || '(no reply — the AI handed off)' }),
            h('div', { class: 'meta', text: 'Assistant · just now' })));
          var notes = [];
          if (r.handedOff) notes.push('would hand off to a human');
          (r.sandboxEvents || []).forEach(function (ev) { notes.push(pretty(ev.tool) + ': ' + ev.detail); });
          clear(toolsOut);
          toolsOut.textContent = notes.length ? 'Sandbox notes (nothing really happened): ' + notes.join(' · ') : 'Sandbox notes: none — a plain reply, nothing else.';
        }
        ta.disabled = false; send.disabled = false; ta.focus();
        say('Replied in the sandbox.');
      }).catch(function (e) { ta.disabled = false; send.disabled = false; fail(e); });
    });
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send.click(); } });
    card.appendChild(msgs); card.appendChild(toolsOut);
    card.appendChild(h('div', { class: 'row', style: 'margin-top:10px;' }, ta, send,
      h('button', { type: 'button', class: 'secondary small', text: 'Clear chat', onclick: function () { history = []; clear(msgs); clear(toolsOut); msgs.appendChild(h('p', { class: 'empty', text: 'Fresh start.' })); } })));
  }

  // ---------- ASK AI ----------
  RENDERERS.ask = function () {
    if (!requireClient()) return;
    var page = $('page');
    page.appendChild(h('h1', { text: 'Ask AI' }));
    page.appendChild(h('p', { class: 'sub', text: 'A analyst with perfect memory of your numbers — and no hands. It answers only from your real data, shows which chats it used, and if it thinks something should change it proposes it for you to confirm.' }));
    var chat = h('div', { class: 'aichat', id: 'ask-thread' });
    var ta = h('textarea', { id: 'ask-input', 'aria-label': 'Ask a question', placeholder: 'e.g. Who’s hottest right now? Why did comments drop? Who should I call back today?' });
    var send = h('button', { type: 'submit', text: 'Ask' });
    var suggestions = h('div', { class: 'sourcechips', role: 'list', 'aria-label': 'Suggested questions' });
    ['Who’s hottest right now?', 'Who needs me today?', 'Why did comments drop?', 'How did last week go?'].forEach(function (s) {
      suggestions.appendChild(h('button', { type: 'button', class: 'chip', role: 'listitem', text: s, onclick: function () { ta.value = s; ta.focus(); } }));
    });
    var form = h('form', { class: 'card' }, h('div', { class: 'field', style: 'max-width:46rem;' },
      h('label', { for: 'ask-input' }, 'Ask a question'), ta,
      h('p', { class: 'hint', text: 'Asking costs one AI request. On the free tier, go easy — and if it says “slow down”, wait a few seconds.' })),
      h('div', { class: 'row' }, send, suggestions));
    page.appendChild(chat); page.appendChild(form);

    if (!state.askHistory.length) {
      chat.appendChild(h('p', { class: 'empty', text: 'Ask anything about this business’s DMs, comments, bookings and health.' }));
    } else {
      state.askHistory.forEach(function (m) {
        chat.appendChild(h('div', { class: 'ai-msg ' + (m.role === 'user' ? 'user' : 'bot'), text: m.content }));
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = ta.value.trim();
      if (!q) { say('Type a question first.', true); return; }
      send.disabled = true;
      state.askHistory.push({ role: 'user', content: q });
      chat.appendChild(h('div', { class: 'ai-msg user', text: q }));
      ta.value = '';
      var thinking = h('div', { class: 'ai-msg bot', text: 'Thinking…' });
      chat.appendChild(thinking);
      chat.scrollTop = chat.scrollHeight;
      runAsk(q, thinking, state.askHistory.filter(function (m) { return m.role === 'user'; }).slice(-6).map(function (m) { return { role: 'user', content: m.content }; }))
        .catch(fail).finally(function () { send.disabled = false; });
    });
  };

  /** Shared runner for the Home box and the full Ask AI page: renders answer, sources, proposal. */
  function runAsk(question, outEl, history) {
    return api('POST', '/api/clients/' + state.clientId + '/ask', { question: question, history: history || [] }).then(function (r) {
      clear(outEl);
      outEl.appendChild(h('div', { class: 'ai-msg bot', text: r.answer }));
      if (r.sources && r.sources.length) {
        var chips = h('div', { class: 'sourcechips' }, h('span', { class: 'hint', text: 'Used:' }));
        r.sources.slice(0, 8).forEach(function (s) {
          chips.appendChild(h('button', { type: 'button', class: 'chip', text: '@' + s.username,
            'aria-label': 'Open the conversation with ' + s.username,
            onclick: function (e) { openConvModal(s.conversationId, e.target); } }));
        });
        outEl.appendChild(chips);
      }
      if (r.proposal) {
        var p = r.proposal;
        var what = '';
        if (p.action === 'set_thread_mode') what = 'Switch a thread to “' + modeLabel(p.mode) + '”.';
        else if (p.action === 'take_over_thread') what = 'Pause the AI and take over a thread.';
        else if (p.action === 'hand_back_thread') what = 'Hand a thread back to the AI.';
        else if (p.action === 'update_comment_rules') what = 'Change the comment-to-DM rules.';
        var box = h('div', { class: 'propbox' },
          h('b', { text: 'The AI proposes: ' + what }),
          h('p', { class: 'hint', text: p.reason }),
          h('p', { class: 'hint', text: 'Nothing changes until you confirm.' }));
        var confirmBtn = h('button', { type: 'button', class: 'small', text: 'Confirm' });
        var dismissBtn = h('button', { type: 'button', class: 'secondary small', text: 'Dismiss', onclick: function () { box.remove(); say('Proposal dismissed — nothing was changed.'); } });
        confirmBtn.addEventListener('click', function () {
          confirmBtn.disabled = true;
          api('POST', '/api/ask-ai/confirm', { clientId: state.clientId, proposal: p }).then(function (res) {
            say(res.message || 'Done.');
            box.remove();
          }).catch(function (e) { confirmBtn.disabled = false; fail(e); });
        });
        box.appendChild(h('p', {}, confirmBtn, dismissBtn));
        outEl.appendChild(box);
      }
      if (r.usedModel === false) {
        outEl.appendChild(h('p', { class: 'hint', text: 'No AI model is configured, so this is the raw data.' }));
      }
      state.askHistory.push({ role: 'assistant', content: r.answer });
      return r;
    });
  }

  // ---------- HEALTH & HELP ----------
  RENDERERS.health = function () {
    var page = $('page');
    page.appendChild(h('h1', { text: 'Health & help' }));
    page.appendChild(h('p', { class: 'sub', text: 'Is everything running, what broke recently, and what every setting actually does.' }));
    var cards = h('div', { class: 'stack' });
    page.appendChild(cards);

    var workerCard = h('div', { class: 'card' }, h('h2', { text: 'Is the worker running?' }), h('p', { class: 'hint', text: 'Checking…' }));
    var limitCard = h('div', { class: 'card' }, h('h2', { text: 'AI usage today' }), h('p', { class: 'hint', text: 'Checking…' }));
    var queueCard = h('div', { class: 'card' }, h('h2', { text: 'Queues' }), h('p', { class: 'hint', text: 'Checking…' }));
    var brakeCard = h('div', { class: 'card' }, h('h2', { text: 'Safety brakes' }), h('p', { class: 'hint', text: 'Checking…' }));
    var errCard = h('div', { class: 'card' }, h('h2', { text: 'Recent errors (last 24 hours)' }), h('p', { class: 'hint', text: 'Checking…' }));
    cards.appendChild(workerCard); cards.appendChild(limitCard); cards.appendChild(queueCard); cards.appendChild(brakeCard); cards.appendChild(errCard);

    api('GET', '/api/health' + (state.clientId ? '?clientId=' + encodeURIComponent(state.clientId) : '')).then(function (r) {
      clear(workerCard);
      var tagEl = r.worker.alive === true ? h('span', { class: 'tag ok', text: 'Running' })
        : r.worker.alive === false ? h('span', { class: 'tag bad', text: 'Not responding' })
        : h('span', { class: 'tag', text: 'No heartbeat yet' });
      workerCard.appendChild(h('p', {}, tagEl));
      workerCard.appendChild(h('p', { text: r.worker.note }));
      workerCard.appendChild(h('p', { class: 'hint', text: r.worker.lastHeartbeatAt ? 'Last check-in: ' + when(r.worker.lastHeartbeatAt) : 'The worker writes a heartbeat every 30 seconds once it runs.' }));

      clear(limitCard);
      var pct = r.usage.limit > 0 ? Math.min(100, Math.round((r.usage.today / r.usage.limit) * 100)) : 0;
      var warn = pct >= 80;
      limitCard.appendChild(h('p', {}, h('b', { text: r.usage.today + ' of about ' + r.usage.limit + ' AI requests used today' + (warn ? ' — close to the free limit' : '') })));
      var bar = h('div', { class: 'bar' + (warn ? ' warnbar' : ''), role: 'img', 'aria-label': pct + ' percent of the estimated daily AI limit used' }, h('span', { style: 'width:' + pct + '%' }));
      limitCard.appendChild(bar);
      var kinds = r.usage.byKind.map(function (k) { return pretty(k.kind) + ': ' + k.calls; }).join(' · ');
      limitCard.appendChild(h('p', { class: 'hint', text: (kinds || 'No requests yet today.') + ' ' + r.usage.note }));
      if (warn) limitCard.appendChild(h('p', { class: 'hint', style: 'color:var(--warn);font-weight:600;', text: 'When the free tier runs out, replies pause until tomorrow or until you upgrade. Leads are never messaged with an error.' }));

      clear(queueCard);
      queueCard.appendChild(h('dl', { class: 'dl' },
        h('dt', { text: 'Jobs waiting' }), h('dd', { text: String(r.queues.jobsPending) }),
        h('dt', { text: 'Jobs running now' }), h('dd', { text: String(r.queues.jobsRunning) }),
        h('dt', { text: 'Messages waiting to send' }), h('dd', { text: String(r.queues.sendsPending) }),
        h('dt', { text: 'Failed jobs (24h)' }), h('dd', { text: String(r.queues.deadJobs24h) })));
      queueCard.appendChild(h('p', { class: 'hint', text: '“Jobs” are the small tasks the worker chews through: read a message, think, send, schedule. A few waiting is normal; hundreds mean the worker is behind or down.' }));

      clear(brakeCard);
      if (!r.brakes.length) brakeCard.appendChild(h('p', { text: 'No brakes are on. ' }));
      else r.brakes.forEach(function (b) {
        brakeCard.appendChild(h('p', {}, h('span', { class: 'tag warn', text: 'Brake on' }), ' ' + b.reason + ' — until ' + when(b.until)));
      });
      brakeCard.appendChild(h('p', { class: 'hint', text: 'Brakes slow sending automatically when replies drop or errors spike — Instagram protection, not a punishment.' }));

      clear(errCard);
      if (!r.errors.length) errCard.appendChild(h('p', { text: 'No errors in the last 24 hours. Nice.' }));
      else {
        var tb = h('tbody', {});
        r.errors.forEach(function (eItem) {
          tb.appendChild(h('tr', {}, h('th', { scope: 'row', text: eItem.where }), h('td', { text: when(eItem.at) }), h('td', { text: eItem.message })));
        });
        errCard.appendChild(h('div', { class: 'scroll' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Where' }), h('th', { scope: 'col', text: 'When' }), h('th', { scope: 'col', text: 'What went wrong' }))), tb)));
      }
    }).catch(fail);

    cards.appendChild(helpCard());
  };
  function helpCard() {
    var items = [
      ['Default way the AI handles new chats (mode)', 'The AI’s playbook: “Qualify and book” balances chat and booking; “Soft nurture” is low pressure; “Direct closer” pushes to the point for hot leads; “No-show recovery” gently rebooks missed calls.'],
      ['Lowest score to DM automatically', 'A commenter’s score mixes how interested they seem (60%) and how well they match your ideal customer (40%). Below the bar, they follow the “what to do with them” rule instead of getting a DM.'],
      ['Most comment DMs per day', 'A hard ceiling so Instagram never sees a flood. Empty = the account’s normal daily limit, which also ramps up slowly on a fresh account.'],
      ['Minimum minutes between comment DMs', 'Spacing between first DMs. A random extra few minutes are added so the pace feels human.'],
      ['Hours the AI stays quiet after you reply yourself', 'When a human sends a message in a thread, the AI steps back for this long so you never talk over each other.'],
      ['Pause the AI — take over myself', 'Instantly stops all sends and follow-ups on that thread until you press “Hand back”. Replying from Instagram does the same thing automatically.'],
      ['Call status', 'Tracks the actual call: booked, rescheduled, cancelled, completed, no-show. It drives the nudges — a confirmed call cancels “please book” messages; a no-show starts gentle rebooking.'],
      ['Next follow-up', 'After every message the AI plans whether to follow up, when, and why. Hard limits still apply: opt-outs, quiet hours, caps and Instagram’s 24-hour window always win.'],
      ['Held for review (comments)', 'Commenters below your score bar wait here. Approve to send them a first DM, skip to leave them alone.'],
      ['Flagged comments', 'Hostile or sensitive comments the AI will not touch. A human should read them.'],
      ['Facts file (knowledge base)', 'The only source the AI may quote for prices, process and FAQs. If a fact is not there, it will not invent one — it hands off instead.'],
      ['Booking link', 'The only link the AI may ever send. Nothing else gets through, even if a lead asks.'],
      ['Describe-it box', 'Type what you want changed; the AI drafts exact before/after edits to the settings it reads. Nothing is applied until you press Apply. It can never change the AI’s core logic.'],
      ['Ask AI', 'Answers questions from your live data only, and shows which conversations it used. It never changes anything by itself — proposals need your confirm.'],
      ['Free-limit warnings', 'Counts today’s AI requests against an estimate of the free tier (set AI_FREE_DAILY_REQUEST_LIMIT to match your plan). Near the limit, the Health page warns you before replies start pausing.'],
    ];
    var dl = h('dl', { class: 'dl' });
    items.forEach(function (it) { dl.appendChild(h('dt', { text: it[0] })); dl.appendChild(h('dd', { text: it[1] })); });
    return h('div', { class: 'card' }, h('h2', { text: 'What every setting means' }), h('p', { class: 'sub', text: 'Plain words, no jargon.' }), dl);
  }

  // ---------- boot ----------
  function boot() {
    if (!state.token) { render(); return; }
    api('GET', '/api/clients').then(function (list) {
      state.clients = list;
      ensureClientId();
      fillClientSelect();
      api('GET', '/api/modes').then(function (modes) { state.modes = modes; render(); }).catch(function () { render(); });
    }).catch(function () { render(); });
  }
  boot();
})();

</script>
</body>
</html>`;
