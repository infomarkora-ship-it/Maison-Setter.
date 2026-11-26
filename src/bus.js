/* Real-time plumbing, in memory and dependency free.
   - Dashboard: every change publishes a small event; /api/stream sends it to open dashboards (server-sent events).
   - Extension: each account has a revision number. /ext/pulse holds the request open until that number moves
     (a lead was approved for it, it was paused, a setting changed) or 25 seconds pass, so the extension reacts at once
     instead of waiting for its next one-minute check. */
function createBus() {
  const subs = new Set();
  const revs = new Map();            // accountId -> number
  const waiters = new Map();         // accountId -> Set<fn>
  let global = 0;

  const rev = (id) => (revs.get(Number(id)) || 0) + global;
  function wake(id) { const set = waiters.get(Number(id)); if (set) for (const fn of [...set]) fn(); }

  return {
    publish(evt) { const e = { at: Date.now(), ...evt }; for (const fn of subs) { try { fn(e); } catch { /* a closed socket */ } } },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    subscribers: () => subs.size,

    rev,
    bump(id) { revs.set(Number(id), (revs.get(Number(id)) || 0) + 1); wake(id); },
    bumpAll(ids = []) { global++; for (const id of ids) wake(id); },

    /* Resolves with the current revision as soon as it differs from `since`, or after `ms`. */
    waitForChange(id, since, ms, signal) {
      return new Promise((resolve) => {
        const key = Number(id);
        if (rev(key) !== since) return resolve(rev(key));
        let timer = null;
        const done = () => { clearTimeout(timer); const set = waiters.get(key); if (set) { set.delete(done); if (!set.size) waiters.delete(key); } if (signal) signal.removeEventListener?.("abort", done); resolve(rev(key)); };
        if (!waiters.has(key)) waiters.set(key, new Set());
        waiters.get(key).add(done);
        timer = setTimeout(done, ms); timer.unref?.();
        if (signal) signal.addEventListener?.("abort", done);
      });
    },
    releaseAll() { for (const set of waiters.values()) for (const fn of [...set]) fn(); }
  };
}
module.exports = { createBus };
