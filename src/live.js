/* Senders Live: what every sender's browser is doing RIGHT NOW.
   The Chrome extension posts a small status blob whenever something changes and at least every
   ~20 seconds (POST /ext/status). This module keeps the latest blob per account in memory and
   publishes it on the event bus, so an open dashboard updates the moment a status lands.
   v3.4: the blob can carry a batch of narrated diary lines ("opened @x's profile", "watched their
   story", "typing the opener"). They are kept in a per-account ring here (the Day diary page reads
   them live) AND mirrored into the activity table, so the diary survives a restart and every
   micro-step also lands in the dashboard's live feed.
   Nothing else here hits the database: a restart simply resets the live cards to "waiting for the
   next ping" (the diary rebuilds from the activity table).
   Runner-driven accounts report through the heartbeats the runner already sends — their card is
   built from accounts.summary() data (last_action, last_seen_at), with no runner changes. */
function createLive() {
  const byId = new Map();                 // accountId -> status blob
  const logs = new Map();                 // accountId -> recent { at, text } lines (extension step log)
  const diary = new Map();                // accountId -> recent { at, text } narrated micro-steps
  let published = 0;
  const LOG_MAX = 24, DIARY_MAX = 150;

  function update(accountId, blob) {
    const id = Number(accountId);
    if (!Number.isFinite(id)) return;
    const prev = byId.get(id);
    const next = { ...blob, id, at: Date.now() };
    byId.set(id, next);
    if (blob.logLine) {
      const list = logs.get(id) || [];
      if (!list.length || list[0].text !== blob.logLine) list.unshift({ at: Date.now(), text: String(blob.logLine).slice(0, 200) });
      while (list.length > LOG_MAX) list.pop();
      logs.set(id, list);
    }
    published++;
    return next;
  }

  /* Narrated micro-steps: the extension sends only the NEW lines since its last push. */
  function diaryAdd(accountId, lines) {
    const id = Number(accountId);
    if (!Number.isFinite(id) || !Array.isArray(lines)) return 0;
    let n = 0;
    const list = diary.get(id) || [];
    for (const raw of lines.slice(0, 20)) {
      const text = String(raw || "").slice(0, 220).trim();
      if (!text) continue;
      list.unshift({ at: Date.now(), text });
      n++;
    }
    while (list.length > DIARY_MAX) list.pop();
    if (list.length) diary.set(id, list);
    return n;
  }

  const get = (id) => byId.get(Number(id)) || null;
  const logOf = (id) => logs.get(Number(id)) || [];
  const diaryOf = (id, limit = 120) => (diary.get(Number(id)) || []).slice(0, limit);
  const all = () => [...byId.values()];
  const stats = () => ({ accounts: byId.size, updates: published });
  /* A sender is "live" when its last status ping is under two minutes old. */
  const fresh = (id, ms = 120_000) => { const s = byId.get(Number(id)); return !!s && Date.now() - s.at < ms; };
  return { update, diaryAdd, get, logOf, diaryOf, all, stats, fresh };
}
module.exports = { createLive };
