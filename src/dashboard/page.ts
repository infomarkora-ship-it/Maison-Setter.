/**
 * Accessible single-page dashboard served at GET /dashboard.
 * - Semantic landmarks, skip link, labelled controls, real tables/buttons (everything reachable by Tab, no custom widgets).
 * - Focus moves to a panel when it opens; Escape closes the conversation and returns focus to the row that opened it.
 * - Status changes announced via aria-live; meaning never carried by colour alone; high-contrast light/dark/forced-colors.
 * - All data is inserted with textContent (never innerHTML), so lead messages cannot inject markup or script.
 * The admin token is kept in sessionStorage only, and sent as a Bearer header to /api/*.
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
<title>DM Setter dashboard</title>
<style>
  :root { color-scheme: light dark; --bg:#ffffff; --fg:#111111; --muted:#3d3d3d; --card:#f4f4f4; --line:#6b6b6b; --accent:#0b3fb5; --accent-fg:#ffffff; --mark:#fff2b3; --ok:#0b5d1e; --bad:#9c1111; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0b0b; --fg:#f5f5f5; --muted:#d0d0d0; --card:#1a1a1a; --line:#9a9a9a; --accent:#8fb4ff; --accent-fg:#001a4d; --mark:#4a3f00; --ok:#7be495; --bad:#ff9a9a; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:17px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  a, button, input, select, textarea { font:inherit; }
  header, main { max-width: 1200px; margin: 0 auto; padding: 12px 16px; }
  h1 { font-size: 1.6rem; margin: 8px 0; } h2 { font-size: 1.3rem; margin: 0 0 8px; } h3 { font-size: 1.1rem; margin: 16px 0 6px; }
  section, .panel { background:var(--card); border:2px solid var(--line); border-radius:8px; padding:12px 16px; margin: 14px 0; }
  .skip { position:absolute; left:-999px; top:0; background:var(--accent); color:var(--accent-fg); padding:10px 14px; z-index:10; }
  .skip:focus { left:8px; top:8px; }
  :focus-visible { outline: 4px solid var(--accent); outline-offset: 2px; }
  label { display:block; font-weight:600; margin: 10px 0 4px; }
  .hint { color:var(--muted); font-size:.95rem; margin:2px 0 0; }
  input, select, textarea { width:100%; max-width:34rem; padding:8px 10px; border:2px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); }
  textarea { min-height: 5rem; }
  button { padding:8px 14px; border:2px solid var(--fg); border-radius:6px; background:var(--accent); color:var(--accent-fg); font-weight:700; cursor:pointer; margin: 6px 6px 0 0; min-height:44px; }
  button.secondary { background:var(--bg); color:var(--fg); }
  .grid { display:grid; gap: 4px 20px; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; min-width: 760px; }
  caption { text-align:left; font-weight:700; padding:6px 0; }
  th, td { border:1px solid var(--line); padding:6px 8px; text-align:left; vertical-align:top; }
  th { background:var(--bg); }
  ol.timeline { list-style:none; margin:0; padding:0; }
  ol.timeline li { border-left:4px solid var(--line); padding:4px 0 4px 10px; margin:6px 0; }
  ol.timeline li.key { background:var(--mark); border-left-color:var(--fg); font-weight:600; }
  .tag { display:inline-block; border:2px solid var(--fg); border-radius:4px; padding:0 6px; font-size:.85rem; font-weight:700; margin-right:6px; }
  .msg { border:1px solid var(--line); border-radius:6px; padding:6px 10px; margin:6px 0; max-width: 46rem; background:var(--bg); }
  .msg.out { margin-left: 2rem; }
  .who { font-weight:700; } .when { color:var(--muted); font-size:.9rem; }
  blockquote { margin:6px 0; padding:4px 10px; border-left:4px solid var(--fg); background:var(--bg); }
  #status { min-height:1.5em; font-weight:700; }
  .err { color:var(--bad); } .good { color:var(--ok); }
  [hidden] { display:none !important; }
  @media (forced-colors: active) { button, input, select, textarea { border:2px solid ButtonText; } }
  @media (prefers-reduced-motion: reduce) { * { scroll-behavior:auto !important; transition:none !important; } }
</style>
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<header>
  <h1>DM Setter dashboard</h1>
  <p id="status" role="status" aria-live="polite"></p>
</header>
<main id="main" tabindex="-1">

<section id="login" aria-labelledby="login-h">
  <h2 id="login-h">Connect</h2>
  <form id="login-form">
    <label for="token">Admin token</label>
    <input id="token" type="password" autocomplete="off" aria-describedby="token-hint" required>
    <p id="token-hint" class="hint">The value of ADMIN_TOKEN. Kept only in this browser tab.</p>
    <button type="submit">Connect</button>
  </form>
</section>

<div id="app" hidden>
  <section aria-labelledby="client-h">
    <h2 id="client-h">Client</h2>
    <label for="client-select">Choose a client</label>
    <select id="client-select"></select>
    <button type="button" id="refresh" class="secondary">Refresh data</button>
  </section>

  <section aria-labelledby="ctl-h">
    <h2 id="ctl-h">Comment-to-DM rules and default mode</h2>
    <p id="today" class="hint"></p>
    <form id="ctl-form">
      <div class="grid">
        <div><label for="c-mode">Default mode for new threads</label><select id="c-mode"></select><p id="c-mode-desc" class="hint"></p></div>
        <div><label for="c-min">Minimum lead score for an automatic DM (0 to 100)</label><input id="c-min" type="number" min="0" max="100" aria-describedby="c-min-h"><p id="c-min-h" class="hint">0 turns the threshold off. Lead score = 60% intent + 40% fit.</p></div>
        <div><label for="c-low">When a commenter scores below the minimum</label><select id="c-low"><option value="review">Hold for my review</option><option value="public_reply_only">Reply publicly only, no DM</option><option value="skip">Skip them</option></select></div>
        <div><label for="c-max">Maximum comment DMs per day</label><input id="c-max" type="number" min="0" max="1000" aria-describedby="c-max-h"><p id="c-max-h" class="hint">Leave empty to use the account's normal daily limit.</p></div>
        <div><label for="c-gap">Minimum minutes between comment DMs</label><input id="c-gap" type="number" min="2" max="240"></div>
        <div><label for="c-pause">Hours the AI stays quiet after a human replies</label><input id="c-pause" type="number" min="1" max="168"></div>
      </div>
      <button type="submit">Save settings</button>
    </form>
  </section>

  <section aria-labelledby="rev-h">
    <h2 id="rev-h">Comments held for review</h2>
    <div class="scroll"><table id="rev-table"><caption>Low-score commenters waiting for your decision</caption>
      <thead><tr><th scope="col">Commenter</th><th scope="col">Comment</th><th scope="col">Lead score</th><th scope="col">Reason</th><th scope="col">Actions</th></tr></thead><tbody></tbody></table></div>
    <p id="rev-empty" class="hint" hidden>Nothing is waiting for review.</p>
  </section>

  <section aria-labelledby="conv-h">
    <h2 id="conv-h">Conversations</h2>
    <div class="scroll"><table id="conv-table"><caption>Conversations, most recent first</caption>
      <thead><tr><th scope="col">Lead</th><th scope="col">Lead score</th><th scope="col">State</th><th scope="col">Call status</th><th scope="col">Mode</th><th scope="col">DM’d from comment</th><th scope="col">Booking link sent</th><th scope="col">Next follow-up</th><th scope="col">Open</th></tr></thead><tbody></tbody></table></div>
    <p id="conv-empty" class="hint" hidden>No conversations yet.</p>
  </section>

  <section id="detail" aria-labelledby="detail-h" tabindex="-1" hidden>
    <h2 id="detail-h">Conversation</h2>
    <button type="button" id="close-detail" class="secondary">Close conversation (Escape)</button>
    <div class="grid">
      <div><label for="d-mode">Mode for this thread</label><select id="d-mode"></select><button type="button" id="d-mode-save">Apply mode</button></div>
      <div><label for="d-call">Call status</label><select id="d-call"></select><button type="button" id="d-call-save">Apply call status</button></div>
    </div>
    <p><button type="button" id="d-takeover" class="secondary">Take over (pause the AI)</button><button type="button" id="d-handback" class="secondary">Hand back to the AI</button></p>
    <h3>Planned next follow-up</h3><p id="d-plan"></p>
    <h3>Milestones and events</h3><ol id="d-miles" class="timeline"></ol>
    <h3 id="bot-h">Context Bot</h3>
    <form id="bot-form" aria-labelledby="bot-h">
      <label for="bot-q">Ask about this lead</label>
      <textarea id="bot-q" aria-describedby="bot-hint" placeholder="How does she talk? When did we send the booking link? What objections came up?"></textarea>
      <p id="bot-hint" class="hint">Answers use only this conversation and include quotes with timestamps.</p>
      <button type="submit">Ask</button>
    </form>
    <div id="bot-out" aria-live="polite"></div>
    <h3>Messages</h3><div id="d-msgs"></div>
  </section>
</div>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var token = sessionStorage.getItem('dmsetter_token') || '';
  var clients = [], currentClient = null, currentConv = null, lastOpener = null, MODES = [];
  var CALLS = ['no_booking_link_sent','booking_link_sent','call_booked','call_rescheduled','call_canceled','call_completed','call_no_show'];

  function h(tag, attrs) {
    var el = document.createElement(tag);
    for (var k in (attrs || {})) { if (k === 'text') el.textContent = attrs[k]; else el.setAttribute(k, attrs[k]); }
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c == null) continue; el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return el;
  }
  function say(msg, bad) { var s = $('status'); s.textContent = msg; s.className = bad ? 'err' : 'good'; }
  function pretty(s) { return s ? String(s).replace(/_/g, ' ') : 'none'; }
  function when(iso) { return iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'not yet'; }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function api(method, path, body) {
    return fetch(path, { method: method, headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        if (r.status === 401) { sessionStorage.removeItem('dmsetter_token'); token = ''; $('app').hidden = true; $('login').hidden = false; throw new Error('Token not accepted. Please connect again.'); }
        return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('Request failed (' + r.status + ')')); return j; });
      });
  }
  function fail(e) { say(e.message || 'Something went wrong', true); }

  function fillSelect(sel, items, value) {
    clear(sel);
    items.forEach(function (it) { var o = h('option', { value: it.value, text: it.label }); if (it.value === value) o.selected = true; sel.appendChild(o); });
  }

  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault(); token = $('token').value.trim(); sessionStorage.setItem('dmsetter_token', token); start();
  });

  function start() {
    if (!token) return;
    api('GET', '/api/modes').then(function (m) {
      MODES = m;
      fillSelect($('c-mode'), m.map(function (x) { return { value: x.id, label: x.label }; }));
      fillSelect($('d-mode'), [{ value: '', label: 'Use client default' }].concat(m.map(function (x) { return { value: x.id, label: x.label }; })));
      fillSelect($('d-call'), CALLS.map(function (c) { return { value: c, label: pretty(c) }; }));
      return api('GET', '/api/clients');
    }).then(function (list) {
      clients = list; $('login').hidden = true; $('app').hidden = false;
      fillSelect($('client-select'), list.map(function (c) { return { value: c.id, label: c.name }; }));
      say(list.length ? 'Connected.' : 'Connected. No clients exist yet.');
      if (list.length) loadClient($('client-select').value);
    }).catch(fail);
  }

  $('client-select').addEventListener('change', function () { loadClient(this.value); });
  $('refresh').addEventListener('click', function () { if (currentClient) loadClient(currentClient.id); });

  function loadClient(id) {
    closeDetail(true);
    api('GET', '/api/clients/' + id).then(function (c) {
      currentClient = c;
      $('c-mode').value = c.defaultMode; $('c-min').value = c.minCommentDmScore;
      $('c-low').value = c.lowScoreAction; $('c-max').value = c.maxCommentDmsPerDay == null ? '' : c.maxCommentDmsPerDay;
      $('c-gap').value = c.commentDmMinGapMinutes; $('c-pause').value = c.humanPauseHours;
      updateModeDesc();
      $('today').textContent = 'Comment DMs sent today: ' + c.commentDmsToday + ' of ' + c.commentDmCapToday + ' allowed. Held for review: ' + c.reviewQueue + '.';
    }).then(function () { return Promise.all([api('GET', '/api/clients/' + id + '/conversations'), api('GET', '/api/clients/' + id + '/review-comments')]); })
      .then(function (r) { renderConvs(r[0]); renderReview(r[1]); }).catch(fail);
  }
  function updateModeDesc() { var m = MODES.filter(function (x) { return x.id === $('c-mode').value; })[0]; $('c-mode-desc').textContent = m ? m.description : ''; }
  $('c-mode').addEventListener('change', updateModeDesc);

  $('ctl-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var max = $('c-max').value.trim();
    api('PATCH', '/api/clients/' + currentClient.id + '/controls', {
      defaultMode: $('c-mode').value, minCommentDmScore: Number($('c-min').value || 0), lowScoreAction: $('c-low').value,
      maxCommentDmsPerDay: max === '' ? null : Number(max), commentDmMinGapMinutes: Number($('c-gap').value || 2), humanPauseHours: Number($('c-pause').value || 24)
    }).then(function () { say('Settings saved.'); loadClient(currentClient.id); }).catch(fail);
  });

  function renderReview(rows) {
    var tb = $('rev-table').tBodies[0]; clear(tb); $('rev-empty').hidden = rows.length > 0; $('rev-table').hidden = rows.length === 0;
    rows.forEach(function (c) {
      var who = '@' + (c.authorUsername || c.authorId);
      var ok = h('button', { type: 'button', text: 'Send DM', 'aria-label': 'Approve and send a DM to ' + who });
      var no = h('button', { type: 'button', class: 'secondary', text: 'Dismiss', 'aria-label': 'Dismiss ' + who });
      ok.addEventListener('click', function () { api('POST', '/api/comments/' + c.id + '/approve').then(function () { say('Approved. The DM will go out within your daily limits.'); loadClient(currentClient.id); }).catch(fail); });
      no.addEventListener('click', function () { api('POST', '/api/comments/' + c.id + '/dismiss').then(function () { say('Dismissed.'); loadClient(currentClient.id); }).catch(fail); });
      tb.appendChild(h('tr', {}, h('td', { text: who }), h('td', { text: c.text }), h('td', { text: c.leadScore == null ? 'n/a' : String(c.leadScore) }), h('td', { text: c.reason || '' }), h('td', {}, ok, no)));
    });
  }

  function renderConvs(rows) {
    var tb = $('conv-table').tBodies[0]; clear(tb); $('conv-empty').hidden = rows.length > 0; $('conv-table').hidden = rows.length === 0;
    rows.forEach(function (c) {
      var who = '@' + (c.username || c.platformUserId);
      var paused = c.humanTakeover || c.mode === 'paused_human';
      var open = h('button', { type: 'button', text: 'Open', 'aria-label': 'Open conversation with ' + who });
      open.addEventListener('click', function () { lastOpener = open; openConv(c.id); });
      tb.appendChild(h('tr', {},
        h('th', { scope: 'row', text: who + (paused ? ' (AI paused)' : '') + (c.doNotContact ? ' (do not contact)' : '') }),
        h('td', { text: c.leadScore == null ? 'n/a' : String(c.leadScore) }), h('td', { text: pretty(c.state) }), h('td', { text: pretty(c.callStatus) }),
        h('td', { text: c.mode ? pretty(c.mode) : 'client default' }), h('td', { text: c.commentDmSentAt ? when(c.commentDmSentAt) : 'No' }),
        h('td', { text: c.bookingLinkSentAt ? when(c.bookingLinkSentAt) : 'No' }),
        h('td', { text: c.nextFollowUpAt ? when(c.nextFollowUpAt) + (c.conversationGoal ? ' (' + pretty(c.conversationGoal) + ')' : '') : 'None planned' }),
        h('td', {}, open)));
    });
  }

  function openConv(id) {
    api('GET', '/api/conversations/' + id).then(function (d) {
      currentConv = d.conversation; var c = d.conversation;
      $('detail').hidden = false;
      $('detail-h').textContent = 'Conversation with @' + (c.username || 'unknown');
      $('d-mode').value = c.mode || ''; $('d-call').value = c.callStatus;
      var plan = $('d-plan');
      plan.textContent = c.nextFollowUpAt
        ? when(c.nextFollowUpAt) + ' | Goal: ' + pretty(c.goal) + (c.followUpRationale ? ' | Why: ' + c.followUpRationale : '')
        : 'No follow-up planned.' + (c.goal ? ' Current goal: ' + pretty(c.goal) + '.' : '');
      var ol = $('d-miles'); clear(ol);
      d.milestones.forEach(function (m) {
        var key = m.kind === 'booking_link_sent' || m.kind === 'comment_dm_sent';
        var li = h('li', key ? { class: 'key' } : {});
        if (key) li.appendChild(h('span', { class: 'tag', text: 'KEY MILESTONE' }));
        li.appendChild(h('span', { text: m.label + ': ' }));
        var t = h('time', { text: m.atLocal || 'unknown time' }); if (m.at) t.setAttribute('datetime', m.at); li.appendChild(t);
        if (m.detail) li.appendChild(h('span', { text: ' (' + m.detail + ')' }));
        ol.appendChild(li);
      });
      var box = $('d-msgs'); clear(box);
      d.messages.forEach(function (m) {
        var lead = m.direction === 'in';
        box.appendChild(h('div', { class: 'msg ' + (lead ? 'in' : 'out') }, h('span', { class: 'who', text: lead ? 'Lead' : 'AI or team' }), h('span', { class: 'when', text: ' ' + when(m.at) }), h('div', { text: m.body })));
      });
      clear($('bot-out'));
      $('detail').focus(); say('Opened conversation.');
    }).catch(fail);
  }
  function closeDetail(silent) {
    if ($('detail').hidden) return; $('detail').hidden = true; currentConv = null;
    if (!silent && lastOpener && document.body.contains(lastOpener)) lastOpener.focus();
  }
  $('close-detail').addEventListener('click', function () { closeDetail(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('detail').hidden) closeDetail(false); });

  function reload() { if (currentConv) openConv(currentConv.id); if (currentClient) api('GET', '/api/clients/' + currentClient.id + '/conversations').then(renderConvs).catch(fail); }
  $('d-mode-save').addEventListener('click', function () { api('POST', '/api/conversations/' + currentConv.id + '/mode', { mode: $('d-mode').value || null }).then(function () { say('Mode updated.'); reload(); }).catch(fail); });
  $('d-call-save').addEventListener('click', function () { api('POST', '/api/conversations/' + currentConv.id + '/call-status', { status: $('d-call').value }).then(function () { say('Call status updated.'); reload(); }).catch(fail); });
  $('d-takeover').addEventListener('click', function () { api('POST', '/api/conversations/' + currentConv.id + '/takeover').then(function () { say('The AI is paused on this thread.'); reload(); }).catch(fail); });
  $('d-handback').addEventListener('click', function () { api('POST', '/api/conversations/' + currentConv.id + '/handback').then(function () { say('Handed back to the AI.'); reload(); }).catch(fail); });

  $('bot-form').addEventListener('submit', function (e) {
    e.preventDefault(); var q = $('bot-q').value.trim(); if (!q) { say('Type a question first.', true); return; }
    say('Thinking...'); var out = $('bot-out'); clear(out);
    api('POST', '/api/conversations/' + currentConv.id + '/ask', { question: q }).then(function (r) {
      out.appendChild(h('h4', { text: 'Answer' }));
      r.answer.split('\n').forEach(function (line) { out.appendChild(h('p', { text: line })); });
      if (r.unverifiedQuotes && r.unverifiedQuotes.length) out.appendChild(h('p', { class: 'err', text: 'The model wrote quotes that are not in the chat, so this answer was replaced by facts computed from the thread.' }));
      out.appendChild(h('h4', { text: 'Quotes and timestamps' }));
      r.references.forEach(function (x) { out.appendChild(h('blockquote', {}, h('span', { class: 'when', text: x.atLocal + ' | ' + (x.who === 'lead' ? 'Lead' : 'Us') + ' | ' + x.why }), h('div', { text: x.quote }))); });
      out.appendChild(h('h4', { text: 'How they communicate' })); out.appendChild(h('p', { text: r.style.summary }));
      say(r.usedModel ? 'Answer ready.' : 'Answer ready (built from the thread data without the model).');
    }).catch(fail);
  });

  if (token) start();
})();
</script>
</body>
</html>`;
